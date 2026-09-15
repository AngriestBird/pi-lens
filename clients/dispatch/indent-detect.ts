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
 * One boolean per line: true when the line sits *inside* a terminated block
 * comment, so its leading space is alignment on the opener's `*` column, not
 * a nesting unit. The opener line itself is false (its own indentation *is*
 * structural). An opener that never closes was a `/*` inside a string or a
 * regex, so its lines are left false rather than silently swallowed.
 *
 * Shared by {@link structuralLines} (drops the lines from indentation
 * detection's own evidence — a top-level JSDoc otherwise contributes a run
 * of 1-space lines, so a 2- or 4-space file with doc comments reads as width
 * 1 and a tab file with a top-level JSDoc reads as spaces, #3039 F1/F2) and
 * by `clients/indent-retarget.ts`'s `retargetReplacementIndentation`, which
 * must not pick its base nesting unit from a comment's alignment column
 * either (#3052) — one lexer for "which lines carry structure", not two.
 */
export function blockCommentInteriorMask(lines: string[]): boolean[] {
	const mask: boolean[] = Array.from({ length: lines.length }, () => false);
	let pendingStart = -1;
	for (const [i, line] of lines.entries()) {
		if (pendingStart >= 0) {
			mask[i] = true;
			if (line.includes("*/")) pendingStart = -1;
			continue;
		}
		if (opensBlockComment(line)) pendingStart = i;
	}
	if (pendingStart >= 0) {
		for (let i = pendingStart + 1; i < lines.length; i += 1) mask[i] = false;
	}
	return mask;
}

function structuralLines(lines: string[]): string[] {
	const mask = blockCommentInteriorMask(lines);
	return lines.filter((_, index) => !mask[index]);
}

function greatestCommonDivisor(left: number, right: number): number {
	while (right !== 0) [left, right] = [right, left % right];
	return left;
}

/** Whether the content supplied evidence from which a style can be inferred. */
export function hasDetectableIndentation(content: string): boolean {
	return /^(?:\t+| {1,})\S/m.test(content);
}
