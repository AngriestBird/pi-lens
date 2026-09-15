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
 * A line inside a terminated `/* … *\/` block comment still gets an exact
 * entry in the map — a replacement that reintroduces that SAME indent
 * (adding another JSDoc continuation, say) still resolves by direct
 * lookup — but that indent is never eligible to be picked as the shortest
 * ("base") unit and extrapolated to a deeper level `newText` adds that
 * oldText never showed: its leading space is alignment on the opener's `*`
 * column, not a nesting unit, and a doc comment's own alignment ratio can
 * differ from the code's own indentation ratio, silently mis-scaling every
 * such deeper line (#3052). Uses the same lexer as
 * `clients/dispatch/indent-detect.ts`'s `detectIndentation` (#3039) rather
 * than a second one.
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
	// oldIndent keys backed by at least one line OUTSIDE a comment interior —
	// the only keys eligible to be picked as the base unit below. A
	// comment-interior line still lands in indentMap (exact-width lookups
	// must still resolve, #3052 F1), it just cannot anchor the extrapolation.
	const structuralIndents = new Set<string>();
	const ambiguousIndents = new Set<string>();
	for (const [i, oldLine] of oldLines.entries()) {
		// oldLines.length === correctedLines.length is checked above; the "" is
		// unreachable, only satisfying noUncheckedIndexedAccess.
		const correctedLine = correctedLines[i] ?? "";
		const oldIndent = oldLine.match(/^[\t ]*/)?.[0] ?? "";
		const correctedIndent = correctedLine.match(/^[\t ]*/)?.[0] ?? "";
		if (oldIndent === correctedIndent) continue;
		const previous = indentMap.get(oldIndent);
		if (previous !== undefined && previous !== correctedIndent) {
			indentMap.delete(oldIndent);
			structuralIndents.delete(oldIndent);
			ambiguousIndents.add(oldIndent);
			continue;
		}
		if (!ambiguousIndents.has(oldIndent)) {
			indentMap.set(oldIndent, correctedIndent);
			if (!commentInterior[i]) structuralIndents.add(oldIndent);
		}
	}
	if (indentMap.size === 0) return undefined;

	// Find the shortest structurally-backed mapped key as the base unit so
	// that nesting levels in newText that are deeper than anything in
	// oldText can be remapped as n × baseFrom → n × baseTo. A key backed
	// only by comment-interior lines is skipped here (but stays in
	// indentMap for direct lookups above).
	let baseFrom = "";
	let baseTo = "";
	for (const [from, to] of indentMap) {
		if (
			from.length > 0 &&
			structuralIndents.has(from) &&
			(baseFrom === "" || from.length < baseFrom.length)
		) {
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
