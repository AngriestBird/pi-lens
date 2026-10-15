// #4490: CodeQL js/incomplete-sanitization (alerts #65/#66) on the census issue
// body. A test name or error holding `\|` was escaped to `\\|`, which GFM reads
// as an escaped backslash, so the pipe split the table row. The shared escaper
// must keep the row's cell count: the row below has three pipes, the same as a
// row whose cells hold no pipe.
import { describe, expect, it } from "vitest";
import { escapeMarkdownCell } from "../../scripts/lib/markdown-cell.mjs";

// GFM cell boundaries: a backslash escapes the character after it, and a pipe
// that is not escaped separates cells.
function unescapedPipes(row: string): number {
	let count = 0;
	for (let i = 0; i < row.length; i++) {
		if (row[i] === "\\") i++;
		else if (row[i] === "|") count++;
	}
	return count;
}

describe("escapeMarkdownCell", () => {
	it("keeps the row's cell count when a cell holds a backslash before a pipe", () => {
		const input = "a\\|b";
		const row = `| ${escapeMarkdownCell(input)} | x |`;
		expect(unescapedPipes(row)).toBe(3);
	});
});
