type IndentStyle = "tab" | "space";

export interface Indentation {
	style: IndentStyle;
	width: number;
}

const DEFAULT_INDENTATION: Indentation = { style: "space", width: 2 };

/**
 * Infer the prevailing indentation convention from lines that are indented.
 * Formatter callers use it only as a conservative fallback when the repository
 * has no config. Its one piece of lexical knowledge is the `/* … *\/` block
 * comment, whose interior lines are alignment rather than nesting; everything
 * else is counted as written.
 */
export function detectIndentation(content: string): Indentation | undefined {
	const lines = structuralLines(content.split(/\r?\n/));
	const tabs = lines.filter((line) => /^\t+\S/.test(line)).length;
	const spaceCounts = lines
		.map((line) => line.match(/^ +(?=\S)/)?.[0].length ?? 0)
		.filter((count) => count > 0);

	if (tabs === 0 && spaceCounts.length === 0) return DEFAULT_INDENTATION;
	if (tabs > spaceCounts.length) return { style: "tab", width: 1 };
	if (spaceCounts.length > tabs) {
		const minimum = Math.min(...spaceCounts);
		// 0 is GCD's identity, so seeding the fold both satisfies "reduce needs an
		// initial value" and leaves every result unchanged.
		const gcd = spaceCounts.reduce(
			(unit, count) => greatestCommonDivisor(unit, count),
			0,
		);
		const nonBlank = lines
			.map((line) => line.match(/^( *)\S/)?.[1]?.length)
			.filter((count): count is number => count !== undefined);
		const hasStructuralBoundary = nonBlank.some((count, index) => {
			const previous = nonBlank[index - 1];
			return count === minimum && previous !== undefined && previous < minimum;
		});
		if (hasStructuralBoundary && minimum <= 8) {
			return { style: "space", width: minimum };
		}
		// A continuation line can be the shallowest observed line even though it
		// is not one indentation unit from the surrounding structure. GCD gives
		// those aligned runs their structural unit (for example 4/6 -> 2).
		if (gcd < minimum && gcd <= 8) {
			return { style: "space", width: gcd };
		}
		// A file containing only nested runs (for example 6/12 spaces) has no
		// evidence that its first run is one unit rather than three or six. Do
		// not impose a formatter style on that ambiguous evidence.
		return undefined;
	}

	return DEFAULT_INDENTATION;
}

/**
 * Whether the line opens a block comment that it does not also close. A `/*`
 * that follows a `//` on the same line is inside a line comment, not an
 * opener; a `//` that follows the `/*` (a URL in a banner) is not.
 */
function opensBlockComment(line: string): boolean {
	const blockAt = line.indexOf("/*");
	if (blockAt < 0) return false;
	const lineAt = line.indexOf("//");
	if (lineAt >= 0 && lineAt < blockAt) return false;
	return line.indexOf("*/", blockAt + 2) < 0;
}

/**
 * Drop the lines *inside* a block comment from the evidence. Their leading
 * space is alignment on the opener's `*` column, not a nesting unit: a
 * top-level JSDoc contributes a run of 1-space lines, so a 2- or 4-space file
 * with doc comments otherwise reads as width 1 and a tab file with a top-level
 * JSDoc reads as spaces (#3039 F1/F2). The opener line keeps its own
 * indentation, which *is* structural. An opener that never closes was a `/*`
 * inside a string or a regex, so its lines stay in the evidence rather than
 * silently swallowing the rest of the file.
 */
function structuralLines(lines: string[]): string[] {
	const kept: string[] = [];
	let pending: string[] | undefined;
	for (const line of lines) {
		if (pending) {
			pending.push(line);
			if (line.includes("*/")) pending = undefined;
			continue;
		}
		kept.push(line);
		if (opensBlockComment(line)) pending = [];
	}
	if (pending) for (const line of pending) kept.push(line);
	return kept;
}

function greatestCommonDivisor(left: number, right: number): number {
	while (right !== 0) [left, right] = [right, left % right];
	return left;
}

/** Whether the content supplied evidence from which a style can be inferred. */
export function hasDetectableIndentation(content: string): boolean {
	return /^(?:\t+| {1,})\S/m.test(content);
}
