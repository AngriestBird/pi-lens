import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	blankMarkdown,
	issueNumbers,
	parseDefectShapes,
} from "../../scripts/lib/defect-shapes.mjs";

// Recurrence (#4439): shapes 67 and 68 entered the AGENTS.md catalog on
// 2026-10-14 with no HISTORY.md entry, and nothing checked it. The retro
// contract (`docs/pi-lens-retro.md` step 4) puts each shape's issues and PRs in
// HISTORY.md, because AGENTS.md stays lean (agents-governance.test.ts keeps its
// reference count from growing). A shape has history when HISTORY.md, read as
// comment-blanked markdown, carries one of the shape's own issue or PR numbers
// from its catalog entry, or a heading naming `shape N`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const read = (file: string, env?: string): string =>
	fs.readFileSync(
		(env && process.env[env]) || path.join(REPO_ROOT, file),
		"utf8",
	);

/** Catalog shape numbers with no entry in `history`, ascending. */
function shapesWithoutHistory(agents: string, history: string): number[] {
	const blanked = blankMarkdown(history);
	const referenced = issueNumbers(blanked);
	const headed = new Set(
		[...blanked.matchAll(/^#{1,6}[^\n]*\bshape\s+(\d+)\b/gim)].map((match) =>
			Number(match[1]),
		),
	);
	return [...parseDefectShapes(agents)]
		.filter(
			([number, entry]) =>
				!headed.has(number) &&
				![...issueNumbers(entry)].some((issue) => referenced.has(issue)),
		)
		.map(([number]) => number)
		.sort((a, b) => a - b);
}

// Shrink-only baseline: the 57 shapes without HISTORY.md coverage when #4439
// landed (2026-10-14). Backfill a shape's history, then delete its number here;
// never add one. A new shape lands with its HISTORY.md entry.
const NO_HISTORY_BASELINE: readonly number[] = [
	2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24,
	25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43,
	44, 45, 46, 47, 48, 51, 54, 55, 57, 58, 59, 60, 61, 63, 64, 65, 66,
];

describe("catalog shapes have a HISTORY.md entry (#4439)", () => {
	const agents = read("AGENTS.md", "PI_LENS_AGENTS_PATH");
	const history = read("HISTORY.md", "PI_LENS_HISTORY_PATH");
	const uncovered = shapesWithoutHistory(agents, history);

	it("lets no shape outside the baseline lack a HISTORY.md entry", () => {
		const added = uncovered.filter((n) => !NO_HISTORY_BASELINE.includes(n));
		expect(
			added,
			`shape(s) ${added.join(", ")} in AGENTS.md have no HISTORY.md entry: add their issues and PRs to HISTORY.md (retro step 4), never to the baseline`,
		).toEqual([]);
	});

	it("keeps the baseline shrink-only: a covered shape leaves it", () => {
		const stale = NO_HISTORY_BASELINE.filter((n) => !uncovered.includes(n));
		expect(
			stale,
			`shape(s) ${stale.join(", ")} now have history: delete them from NO_HISTORY_BASELINE`,
		).toEqual([]);
	});

	it("lists only catalog shapes, once each, ascending", () => {
		const catalog = parseDefectShapes(agents);
		expect(NO_HISTORY_BASELINE.filter((n) => !catalog.has(n))).toEqual([]);
		expect([...NO_HISTORY_BASELINE]).toEqual(
			[...new Set(NO_HISTORY_BASELINE)].sort((a, b) => a - b),
		);
	});

	it("parses the whole catalog, so the scan is not vacuous", () => {
		expect(parseDefectShapes(agents).size).toBeGreaterThanOrEqual(68);
	});
});

describe("shapesWithoutHistory (#4439)", () => {
	const catalog = (...entries: string[]): string =>
		`## Recurring defect shapes\n\n${entries.join("\n\n")}\n\n## Next\n`;
	const shape = (n: number, text: string) => `${n}. **Shape ${n}:** ${text}`;

	it("ends a catalog entry at the next unindented line", () => {
		// Recurrence: text after an entry (a block tag, a heading) is not the
		// entry's, so a reference there, even on an indented line, must not
		// count as the shape's own.
		const agents = catalog(shape(1, "old.\n    continued (#100)."));
		const trailing = agents.replace(
			"\n\n## Next",
			"\nunindented prose\n    indented #200\n\n## Next",
		);
		expect(parseDefectShapes(trailing).get(1)).toContain("#100");
		expect(parseDefectShapes(trailing).get(1)).not.toContain("#200");
	});

	it("flags a new shape that HISTORY.md never mentions", () => {
		// Recurrence: shapes 67 and 68 landed with no HISTORY.md entry.
		const agents = catalog(shape(1, "old (#100)."), shape(69, "new (#900)."));
		expect(
			shapesWithoutHistory(agents, "# HISTORY\n\nPR #100 landed.\n"),
		).toEqual([69]);
	});

	it("accepts one of the shape's own issue references", () => {
		const agents = catalog(shape(1, "old (#100, #101)."));
		expect(shapesWithoutHistory(agents, "Fixed in #101.")).toEqual([]);
	});

	it("accepts a heading naming the shape when the entry cites no issue", () => {
		const agents = catalog(shape(7, "no issue number here."));
		expect(shapesWithoutHistory(agents, "## 2026-10-14 (shape 7)\n")).toEqual(
			[],
		);
	});

	it("ignores a shape number in prose that is not a heading", () => {
		const agents = catalog(shape(7, "no issue number here."));
		expect(shapesWithoutHistory(agents, "A relative of shape 7.\n")).toEqual([
			7,
		]);
	});

	it("is not satisfied by a reference or heading inside an HTML comment", () => {
		const agents = catalog(shape(1, "old (#100)."), shape(7, "no issue."));
		const history =
			"<!-- #100 -->\n<!--\n## Retro (shape 7)\n-->\nplain text\n";
		expect(shapesWithoutHistory(agents, history)).toEqual([1, 7]);
	});

	it("is not satisfied by a reference inside a fenced block", () => {
		const agents = catalog(shape(1, "old (#100)."));
		expect(shapesWithoutHistory(agents, "```\n#100\n```\n")).toEqual([1]);
	});

	it("does not read a reference from a comment in the catalog entry", () => {
		const agents = catalog(shape(1, "old.\n    <!-- #100 -->"));
		expect(shapesWithoutHistory(agents, "Fixed in #100.")).toEqual([1]);
	});
});
