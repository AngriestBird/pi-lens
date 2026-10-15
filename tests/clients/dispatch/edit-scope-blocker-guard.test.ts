/**
 * #4481 — which blockers the per-edit pass scopes to the lines a write changed.
 *
 * Only line-local rule runners (ast-grep, tree-sitter) are scoped: a
 * structural rule matches the lines it flags, so on the first write to a file
 * (no delta baseline yet) a blocker on an unchanged line is pre-existing.
 * Language servers and linters stay unscoped by design: an edit causes a type
 * error at the callers of a changed signature, or an unused-declaration lint at
 * a line it never touched (maintainer decision, 2026-10-15).
 *
 * Every case drives the real dispatcher (`createDispatchContext` +
 * `dispatchForFile`, blocking-only, with the ranges a host `edit` produces) and
 * the real runner; only the process boundary is faked (the LSP service and the
 * linter child process).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { setupTestEnvironment } from "../test-utils.js";

const boundary = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	touchFile: vi.fn(),
	codeAction: vi.fn(),
	warmDiagnostics: vi.fn(),
	warmCodeActions: vi.fn(),
}));

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawnAsync: boundary.safeSpawnAsync,
}));

vi.mock("../../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/lsp/capabilities.js")
	>()),
	getLSPService: () =>
		makeLspServiceDouble({
			supportsLSP: vi.fn(() => true),
			touchFile: boundary.touchFile,
			codeAction: boundary.codeAction,
		}),
}));

vi.mock("../../../clients/warm-attach.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/warm-attach.js")>()),
	tryWarmAttachedDiagnostics: boundary.warmDiagnostics,
	tryWarmAttachedCodeActions: boundary.warmCodeActions,
}));

const { createDispatchContext, dispatchForFile, RunnerRegistry } =
	await import("../../../clients/dispatch/dispatcher.js");
const lspRunner = (await import("../../../clients/dispatch/runners/lsp.js"))
	.default;
const rubocopRunner = (
	await import("../../../clients/dispatch/runners/rubocop.js")
).default;

/** The write changed line 2 only; every finding on line 1 is outside it. */
const CHANGED = [{ start: 2, end: 2 }];
const SOURCE_TS = "export const a: string = 1;\nexport const b = 2;\n";

let env: ReturnType<typeof setupTestEnvironment>;
beforeEach(() => {
	env = setupTestEnvironment("pi-lens-edit-scope-");
	boundary.safeSpawnAsync.mockReset();
	boundary.touchFile.mockReset();
	boundary.codeAction.mockReset().mockResolvedValue([]);
	boundary.warmDiagnostics.mockReset().mockResolvedValue(undefined);
	boundary.warmCodeActions.mockReset().mockResolvedValue(undefined);
});
afterEach(() => env.cleanup());

function lspDiag(line: number, source?: string, severity = 1) {
	return {
		severity,
		message: source ? `${source} finding` : "Type error",
		range: {
			start: { line: line - 1, character: 0 },
			end: { line: line - 1, character: 1 },
		},
		code: source ? "no-unknown-returns" : "2322",
		...(source && { source }),
	};
}

async function dispatchLsp(diags: unknown[], blockingOnly = true) {
	const filePath = path.join(env.tmpDir, "main.ts");
	fs.writeFileSync(filePath, SOURCE_TS);
	boundary.touchFile.mockResolvedValue({ diags });
	const registry = new RunnerRegistry();
	registry.register(lspRunner);
	return dispatchForFile(
		createDispatchContext(
			filePath,
			env.tmpDir,
			{ getFlag: (flag: string) => flag === "lens-lsp" },
			new FactStore(),
			blockingOnly,
			CHANGED,
		),
		[{ mode: "all", runnerIds: ["lsp"] }],
		registry,
	);
}

describe("per-edit blocker scope (#4481)", () => {
	// Recurrence: #4481 through the ast-grep LSP lane — the same rule catalog
	// as ast-grep-napi, delivered by `ast-grep lsp` when its binary is present.
	it("drops an ast-grep LSP blocker on an unchanged line", async () => {
		const result = await dispatchLsp([lspDiag(1, "ast-grep")]);

		expect(result.blockers.filter((d) => d.tool === "ast-grep")).toEqual([]);
	});

	// Recurrence: an ast-grep LSP gate that drops in-range findings too would
	// hide a blocker the write itself introduced.
	it("keeps an ast-grep LSP blocker on a changed line", async () => {
		const result = await dispatchLsp([lspDiag(2, "ast-grep")]);

		expect(result.blockers).toEqual([
			expect.objectContaining({ tool: "ast-grep", line: 2 }),
		]);
	});

	// Recurrence: a gate that dropped every out-of-range ast-grep finding would
	// erase its warning tier from lens_diagnostics, not only its STOP.
	it("keeps an ast-grep LSP warning on an unchanged line", async () => {
		const result = await dispatchLsp([lspDiag(1, "ast-grep", 2)]);

		expect(result.warnings).toEqual([
			expect.objectContaining({ tool: "ast-grep", line: 1 }),
		]);
	});

	// Recurrence: a gate keyed off the ranges alone would drop blockers from a
	// full (non-blocking) pass that carries the write's ranges.
	it("keeps an unchanged-line ast-grep LSP blocker outside the blocking-only pass", async () => {
		const result = await dispatchLsp([lspDiag(1, "ast-grep")], false);

		expect(result.blockers).toEqual([
			expect.objectContaining({ tool: "ast-grep", line: 1 }),
		]);
	});

	// Recurrence: a range gate added to a semantic runner would hide errors the
	// edit caused, such as a type error at the caller of a changed signature.
	it("keeps a language-server blocker on an unchanged line", async () => {
		const result = await dispatchLsp([lspDiag(1)]);

		expect(result.blockers).toEqual([
			expect.objectContaining({ tool: "lsp", line: 1, semantic: "blocking" }),
		]);
	});

	// Recurrence: a range gate added to a linter would hide a finding the edit
	// caused at a line it never touched (an unused declaration after its last
	// use is deleted, no-undef after a declaration is removed).
	it("keeps a linter blocker on an unchanged line", async () => {
		const filePath = path.join(env.tmpDir, "main.rb");
		fs.writeFileSync(filePath, "value = 1\nputs 'hi'\n");
		boundary.safeSpawnAsync
			.mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: "rubocop",
				stderr: "",
			})
			.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					files: [
						{
							path: filePath,
							offenses: [
								{
									severity: "error",
									message: "Useless assignment to variable - `value`.",
									cop_name: "Lint/UselessAssignment",
									correctable: false,
									location: { line: 1, column: 1 },
								},
							],
						},
					],
				}),
				stderr: "",
			});
		const registry = new RunnerRegistry();
		registry.register(rubocopRunner);

		const result = await dispatchForFile(
			createDispatchContext(
				filePath,
				env.tmpDir,
				{ getFlag: () => false },
				new FactStore(),
				true,
				CHANGED,
			),
			[{ mode: "all", runnerIds: ["rubocop"] }],
			registry,
		);

		expect(result.blockers).toEqual([
			expect.objectContaining({ tool: "rubocop", line: 1 }),
		]);
	});
});
