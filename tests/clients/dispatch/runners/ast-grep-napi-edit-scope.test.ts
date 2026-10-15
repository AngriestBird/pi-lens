/**
 * #4481 — ast-grep must not turn unchanged, pre-existing findings into STOP
 * blockers on the first write to a file in a session.
 *
 * The delta baseline (`session.baseline.<file>`, clients/dispatch/dispatcher.ts)
 * only exists after a file's first dispatch, so on that first write every
 * finding counts as new. The tree-sitter runner already scopes its blocking
 * tier to the lines the write changed (`isLineInModifiedRanges`); the
 * ast-grep-napi runner received the same `ctx.modifiedRanges` and ignored it,
 * so a `severity: error` rule on an unchanged line blocked the agent (the
 * reporter's `no-unknown-returns` STOP after a one-constant edit).
 *
 * These tests drive the production per-edit entry the pipeline calls
 * (`dispatchLintWithResult`: real context, real runner selection, real napi
 * engine, real bundled rules) with the ranges a host `edit` produces.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { resetNapiFallbackCoverageForTests } from "../../../../clients/lsp/pending-aux-coverage.js";
import {
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

const { mockAuxiliaryLspPublished, recordEntitySnapshotDiffMock } = vi.hoisted(
	() => ({
		mockAuxiliaryLspPublished: vi.fn().mockResolvedValue(false),
		recordEntitySnapshotDiffMock: vi.fn(() => ({
			added: [] as string[],
			removed: [] as string[],
			modified: [] as string[],
		})),
	}),
);

// Environment only: whether the ast-grep LSP has published for this root is LSP
// state, not the behavior under test.
vi.mock("../../../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/lsp/capabilities.js")
	>()),
	hasAuxiliaryLspPublishedForRoot: mockAuxiliaryLspPublished,
}));

// The tree-sitter runner shares the dispatch group; an empty entity diff keeps
// its background blast-radius work out of the suite (tests/support/real-runner-ctx.ts).
vi.mock(
	"../../../../clients/review-graph/service.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/review-graph/service.js")
		>()),
		recordEntitySnapshotDiff: recordEntitySnapshotDiffMock,
	}),
);

const { dispatchLintWithResult } =
	await import("../../../../clients/dispatch/integration.js");

const RULE = "no-unknown-returns";

/** The reporter's shape: a constant on line 1 and a pre-existing
 *  `no-unknown-returns` (`severity: error`) violation on line 3. Line 2
 *  violates `no-any-type` (`severity: hint`), which only the substitute role
 *  evaluates. */
const SOURCE = [
	'export const CLIENT_VERSION = "1.0.50";',
	"export const loose: any = CLIENT_VERSION;",
	"export function dig(obj: Record<string, string>, key: string): unknown {",
	"\treturn obj[key];",
	"}",
	"",
].join("\n");
const CONSTANT_LINE = 1;
const HINT_RULE = "no-any-type";
const HINT_LINE = 2;
const FINDING_LINE = 3;
/** The line a later write appends after SOURCE's trailing newline. */
const LATER_LINE = 6;

/** `no-ast-grep` retires the auxiliary, so napi runs on the per-edit blocking
 *  floor; `no-lsp` keeps real language servers out of the suite. */
const PER_EDIT_FLAGS = {
	getFlag: (flag: string) => flag === "no-lsp" || flag === "no-ast-grep",
};
/** The auxiliary stays enabled but has not published, so napi runs as its
 *  substitute at the LSP's severity floor (#2336). */
const SUBSTITUTE_FLAGS = { getFlag: (flag: string) => flag === "no-lsp" };

let env: RealRunnerEnv;
beforeAll(() => {
	env = makeRealRunnerEnv();
});
afterAll(() => env?.cleanup());
beforeEach(() => {
	mockAuxiliaryLspPublished.mockResolvedValue(false);
	resetNapiFallbackCoverageForTests();
});

function napiFindings(
	diagnostics: readonly { tool?: string; rule?: string; line?: number }[],
	rule = RULE,
): { rule?: string; line?: number }[] {
	return diagnostics.filter(
		(d) => d.tool === "ast-grep-napi" && d.rule === rule,
	);
}

describe.each([
	["per-edit floor", PER_EDIT_FLAGS],
	["LSP substitute", SUBSTITUTE_FLAGS],
])("ast-grep-napi edit scope (#4481, %s)", (label, flags) => {
	const slug = label.replace(/\W+/g, "-");

	// Recurrence: #4481 — a one-constant edit, the file's first dispatch this
	// session, STOPped on an unchanged `no-unknown-returns` line.
	it("does not block on an unchanged pre-existing finding on the first write", async () => {
		const { filePath } = env.addFile(`first-write-${slug}.ts`, SOURCE);

		const result = await dispatchLintWithResult(filePath, env.cwd, flags, [
			{ start: CONSTANT_LINE, end: CONSTANT_LINE },
		]);

		expect(napiFindings(result.blockers)).toEqual([]);
		expect(result.blockerOutput).not.toContain(RULE);
	}, 30_000);

	// Recurrence: an edit-scope gate that drops in-range findings too (or keys
	// off the wrong line base) would hide a blocker the write itself introduced.
	it("still blocks a finding on the changed line, on the first and a later write", async () => {
		const { filePath } = env.addFile(`changed-line-${slug}.ts`, SOURCE);

		const first = await dispatchLintWithResult(filePath, env.cwd, flags, [
			{ start: FINDING_LINE, end: FINDING_LINE },
		]);
		expect(napiFindings(first.blockers)).toEqual([
			expect.objectContaining({ rule: RULE, line: FINDING_LINE }),
		]);

		// A later write adds a second violation on a new line it changed: the
		// baseline now exists, and the new finding must still block.
		env.addFile(
			`changed-line-${slug}.ts`,
			`${SOURCE}export const read = (): unknown => undefined;\n`,
		);
		const later = await dispatchLintWithResult(filePath, env.cwd, flags, [
			{ start: LATER_LINE, end: LATER_LINE },
		]);
		expect(napiFindings(later.blockers)).toEqual([
			expect.objectContaining({ rule: RULE, line: LATER_LINE }),
		]);
	}, 30_000);

	// Recurrence: a whole-file write (no partial ranges) must keep blocking —
	// for a genuinely new file the write introduced every line.
	it("blocks on a whole-file write", async () => {
		const { filePath } = env.addFile(`whole-file-${slug}.ts`, SOURCE);

		const result = await dispatchLintWithResult(filePath, env.cwd, flags, [
			{ start: 1, end: SOURCE.split("\n").length },
		]);

		expect(napiFindings(result.blockers)).toEqual([
			expect.objectContaining({ rule: RULE, line: FINDING_LINE }),
		]);
	}, 30_000);
});

describe("ast-grep-napi edit scope outside the blocking tier (#4481)", () => {
	// Recurrence: a gate that also scoped warning-tier rules would cut the
	// substitute's LSP-equivalent coverage (#2336) on every unchanged line.
	it("keeps a hint finding on an unchanged line in the LSP substitute role", async () => {
		const { filePath } = env.addFile("hint-unchanged.ts", SOURCE);

		const result = await dispatchLintWithResult(
			filePath,
			env.cwd,
			SUBSTITUTE_FLAGS,
			[{ start: CONSTANT_LINE, end: CONSTANT_LINE }],
		);

		expect(napiFindings(result.warnings, HINT_RULE)).toEqual([
			expect.objectContaining({ rule: HINT_RULE, line: HINT_LINE }),
		]);
	}, 30_000);

	// Recurrence: a gate keyed off the ranges alone would drop findings from a
	// full (non-blocking) pass that happens to carry the write's ranges.
	it("keeps an unchanged-line error finding when the pass is not blocking-only", async () => {
		const { filePath } = env.addFile("full-pass.ts", SOURCE);

		const result = await dispatchLintWithResult(
			filePath,
			env.cwd,
			PER_EDIT_FLAGS,
			[{ start: CONSTANT_LINE, end: CONSTANT_LINE }],
			undefined,
			{ blockingOnly: false },
		);

		expect(napiFindings(result.diagnostics)).toEqual([
			expect.objectContaining({ rule: RULE, line: FINDING_LINE }),
		]);
	}, 30_000);
});
