import { blockCommentInteriorMask } from "./dispatch/indent-detect.js";

/**
 * Retargets the leading-whitespace style of newText to match the indentation
 * correction that was applied to oldText.
 *
 * Builds a mapping from oldText indentation strings to their corrected forms,
 * then extends it to cover deeper nesting levels (n × baseUnit → n × correctedUnit).
 * Returns undefined — leaving newText unchanged — when any non-blank line in
 * newText has indentation that cannot be resolved, to avoid producing
 * mixed-indentation output.
 *
 * A line inside a terminated `/* … *\/` block comment is excluded from the
 * mapping entirely: its leading space is alignment on the opener's `*`
 * column, not a nesting unit, so it must never be picked as the shortest
 * ("base") indent and extrapolated from — a doc comment's own alignment
 * ratio can differ from the code's own indentation ratio, silently
 * mis-scaling every deeper line `newText` adds (#3052). Uses the same
 * lexer as `clients/dispatch/indent-detect.ts`'s `detectIndentation`
 * (#3039) rather than a second one.
 */
export function retargetReplacementIndentation(
	newText: string,
	oldText: string,
	correctedOldText: string,
): string | undefined {
	const newline = newText.includes("\r\n") ? "\r\n" : "\n";
	const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
	const correctedLines = correctedOldText.replace(/\r\n/g, "\n").split("\n");
	if (oldLines.length !== correctedLines.length) return undefined;
	const commentInterior = blockCommentInteriorMask(oldLines);

	const indentMap = new Map<string, string>();
	const ambiguousIndents = new Set<string>();
	for (const [i, oldLine] of oldLines.entries()) {
		if (commentInterior[i]) continue;
		// oldLines.length === correctedLines.length is checked above; the "" is
		// unreachable, only satisfying noUncheckedIndexedAccess.
		const correctedLine = correctedLines[i] ?? "";
		const oldIndent = oldLine.match(/^[\t ]*/)?.[0] ?? "";
		const correctedIndent = correctedLine.match(/^[\t ]*/)?.[0] ?? "";
		if (oldIndent === correctedIndent) continue;
		const previous = indentMap.get(oldIndent);
		if (previous !== undefined && previous !== correctedIndent) {
			indentMap.delete(oldIndent);
			ambiguousIndents.add(oldIndent);
			continue;
		}
		if (!ambiguousIndents.has(oldIndent)) {
			indentMap.set(oldIndent, correctedIndent);
		}
	}
	if (indentMap.size === 0) return undefined;

	// Find the shortest non-empty mapped key as the base unit so that nesting
	// levels in newText that are deeper than anything in oldText can be remapped
	// as n × baseFrom → n × baseTo.
	let baseFrom = "";
	let baseTo = "";
	for (const [from, to] of indentMap) {
		if (from.length > 0 && (baseFrom === "" || from.length < baseFrom.length)) {
			baseFrom = from;
			baseTo = to;
		}
	}

	function resolveIndent(indent: string): string | undefined {
		if (indent === "") return "";
		const direct = indentMap.get(indent);
		if (direct !== undefined) return direct;
		if (
			baseFrom.length > 0 &&
			indent.length % baseFrom.length === 0 &&
			baseFrom.repeat(indent.length / baseFrom.length) === indent
		) {
			return baseTo.repeat(indent.length / baseFrom.length);
		}
		return undefined;
	}

	let changed = false;
	const newLines = newText.replace(/\r\n/g, "\n").split("\n");
	const retargetedLines: string[] = [];

	for (const line of newLines) {
		const indent = line.match(/^[\t ]*/)?.[0] ?? "";
		if (indent === line) {
			// Blank / whitespace-only line — preserve as-is.
			retargetedLines.push(line);
			continue;
		}
		const resolved = resolveIndent(indent);
		if (resolved === undefined) {
			// Indentation can't be resolved — abort to avoid mixed-indentation output.
			return undefined;
		}
		if (resolved !== indent) {
			changed = true;
			retargetedLines.push(resolved + line.slice(indent.length));
		} else {
			retargetedLines.push(line);
		}
	}

	return changed ? retargetedLines.join(newline) : undefined;
}
