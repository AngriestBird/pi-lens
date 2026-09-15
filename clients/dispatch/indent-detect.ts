type IndentStyle = "tab" | "space";

export interface Indentation {
	style: IndentStyle;
	width: number;
}

const DEFAULT_INDENTATION: Indentation = { style: "space", width: 2 };

/**
 * Infer the prevailing indentation convention from lines that are indented.
 * The detector deliberately has no language knowledge: formatter callers use
 * it only as a conservative fallback when the repository has no config.
 */
export function detectIndentation(content: string): Indentation | undefined {
	const lines = content.split(/\r?\n/);
	const tabs = lines.filter((line) => /^\t+\S/.test(line)).length;
	const spaceCounts = lines
		.map((line) => line.match(/^ +(?=\S)/)?.[0].length ?? 0)
		.filter((count) => count > 0);

	if (tabs === 0 && spaceCounts.length === 0) return DEFAULT_INDENTATION;
	if (tabs > spaceCounts.length) return { style: "tab", width: 1 };
	if (spaceCounts.length > tabs) {
		const minimum = Math.min(...spaceCounts);
		const gcd = spaceCounts.reduce(greatestCommonDivisor);
		const nonBlank = lines
			.map((line) => line.match(/^( *)\S/)?.[1].length)
			.filter((count): count is number => count !== undefined);
		const hasStructuralBoundary = nonBlank.some(
			(count, index) =>
				count === minimum &&
				index > 0 && nonBlank[index - 1] < minimum,
		);
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

function greatestCommonDivisor(left: number, right: number): number {
	while (right !== 0) [left, right] = [right, left % right];
	return left;
}

/** Whether the content supplied evidence from which a style can be inferred. */
export function hasDetectableIndentation(content: string): boolean {
	return /^(?:\t+| {1,})\S/m.test(content);
}
