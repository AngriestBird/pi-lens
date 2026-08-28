import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	makeRunnerCtx,
	type RunnerCtxOverrides,
} from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { mockAuxiliaryLspPublished } = vi.hoisted(() => ({
	mockAuxiliaryLspPublished: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../../clients/lsp/index.js", () => ({
	hasAuxiliaryLspPublishedForRoot: mockAuxiliaryLspPublished,
}));

// Mock heavy dependencies before importing the runner
vi.mock("../../../../clients/tool-policy.js", () => ({
	hasEslintConfig: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../../clients/dispatch/runners/yaml-rule-parser.js", () => ({
	loadYamlRules: vi.fn().mockReturnValue([]),
	isOverlyBroadPattern: vi.fn().mockReturnValue(false),
	isStructuredRule: vi.fn().mockReturnValue(false),
	calculateRuleComplexity: vi.fn().mockReturnValue(1),
	MAX_BLOCKING_RULE_COMPLEXITY: 10,
}));

vi.mock("../../../../clients/package-root.js", () => ({
	resolvePackagePath: vi.fn().mockReturnValue("/nonexistent/path"),
}));

function createCtx(filePath: string, overrides: RunnerCtxOverrides = {}) {
	return makeRunnerCtx(filePath, path.dirname(filePath), {
		blockingOnly: false,
		// Default to the fallback path: the ast-grep LSP supersedes this runner
		// when its binary is available (#239 Phase 2), so to exercise napi's own
		// matching we simulate the binary being ABSENT. The gate is tested
		// explicitly below by overriding hasTool.
		hasTool: async (cmd: string) => cmd !== "ast-grep",
		...overrides,
	});
}

function mockWorkingSgLoad(): void {
	vi.doMock("@ast-grep/napi", () => ({
		ts: {
			parse: vi.fn().mockReturnValue({
				root: () => ({
					children: () => [],
					kind: () => "program",
					range: () => ({
						start: { line: 0, column: 0 },
						end: { line: 1, column: 0 },
					}),
					findAll: () => [],
				}),
			}),
		},
	}));
}

describe("ast-grep-napi runner — LSP supersede gate (#239 Phase 2)", () => {
	beforeEach(() => {
		vi.resetModules();
		mockAuxiliaryLspPublished.mockResolvedValue(false);
	});

	it("runs until the bundled LSP completes its first root publication", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-gate-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const r = arr.sort();\n"); // would match no-sort-without-comparator
			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("succeeded");
			expect(result.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("runs when the launcher binary and PATH are unavailable and no client is live", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-gate-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("succeeded");
		} finally {
			env.cleanup();
		}
	});

	it("skips after the ast-grep LSP completes its first root publication", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-gate-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			mockAuxiliaryLspPublished.mockResolvedValue(true);
			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	// The fallback-RUNS direction (binary absent → napi matches) is covered
	// comprehensively by ast-grep-sonar-rules.test.ts, whose ctx now defaults to
	// hasTool('ast-grep') === false. Asserting it here too would require a working
	// @ast-grep/napi mock and collides with the doMock in the skip-path suite.
});

describe("ast-grep-napi runner — late-auxiliary dedupe (#2324 F3)", () => {
	beforeEach(() => {
		vi.resetModules();
		mockAuxiliaryLspPublished.mockResolvedValue(false);
	});

	it("consumes the pending late-auxiliary pair when it runs as the fallback, so only one delivery surface arms", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-dedupe-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			const pendingAux = await import(
				"../../../../clients/lsp/pending-aux-coverage.js"
			);
			pendingAux.resetPendingAuxiliaryCoverage();
			// Lane 1 arms: the aux-grace wait already found ast-grep silent for
			// this touch and marked it for turn-end late delivery.
			pendingAux.markPendingAuxiliaryCoverage(filePath, ["ast-grep"]);
			expect(
				pendingAux.hasPendingAuxiliaryCoverage(filePath, "ast-grep"),
			).toBe(true);

			mockWorkingSgLoad();
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			// Lane 2 arms: Gate B finds no publication yet, so napi runs and
			// delivers this turn's findings itself.
			const result = await mod.default.run(
				createCtx(filePath, { hasTool: async () => false }) as any,
			);
			expect(result.status).toBe("succeeded");

			// Exactly one delivery surface should remain armed: napi already
			// delivered, so the late-auxiliary lane must be consumed — a
			// pending pair left behind here would redeliver the identical
			// rule/line at the next turn_end as a duplicate.
			expect(
				pendingAux.hasPendingAuxiliaryCoverage(filePath, "ast-grep"),
			).toBe(false);
			pendingAux.resetPendingAuxiliaryCoverage();
		} finally {
			env.cleanup();
		}
	});
});

describe("ast-grep-napi runner — skip paths", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("skips unsupported file extensions", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-");
		try {
			const filePath = path.join(env.tmpDir, "file.py");
			fs.writeFileSync(filePath, "print('hello')\n");

			// Mock @ast-grep/napi so loadSg succeeds
			vi.doMock("@ast-grep/napi", () => ({
				ts: { parse: vi.fn() },
				js: { parse: vi.fn() },
				tsx: { parse: vi.fn() },
				css: { parse: vi.fn() },
				html: { parse: vi.fn() },
			}));

			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const runner = mod.default;
			const result = await runner.run(createCtx(filePath) as any);
			expect(result.status).toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	it("skips when @ast-grep/napi cannot be loaded", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			vi.doMock("@ast-grep/napi", () => {
				throw new Error("module not found");
			});

			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const runner = mod.default;
			const result = await runner.run(createCtx(filePath) as any);
			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("skips when file does not exist", async () => {
		vi.doMock("@ast-grep/napi", () => ({
			ts: { parse: vi.fn() },
			js: { parse: vi.fn() },
			tsx: { parse: vi.fn() },
			css: { parse: vi.fn() },
			html: { parse: vi.fn() },
		}));

		const mod =
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
		const runner = mod.default;
		const result = await runner.run(createCtx("/nonexistent/file.ts") as any);
		expect(result.status).toBe("skipped");
	});

	it("returns succeeded with no diagnostics when no rules are loaded", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			const mockParse = vi.fn().mockReturnValue({
				root: vi.fn().mockReturnValue({
					children: vi.fn().mockReturnValue([]),
					kind: vi.fn().mockReturnValue("program"),
					range: vi.fn().mockReturnValue({
						start: { line: 0, column: 0 },
						end: { line: 1, column: 0 },
					}),
					findAll: vi.fn().mockReturnValue([]),
				}),
			});

			vi.doMock("@ast-grep/napi", () => ({
				ts: { parse: mockParse },
				js: { parse: mockParse },
				tsx: { parse: mockParse },
				css: { parse: mockParse },
				html: { parse: mockParse },
			}));

			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const runner = mod.default;
			const result = await runner.run(createCtx(filePath) as any);
			expect(result.diagnostics).toHaveLength(0);
			expect(["skipped", "succeeded"]).toContain(result.status);
		} finally {
			env.cleanup();
		}
	});
});

describe("ast-grep-napi runner — real shipped rule", () => {
	it("loads and matches no-sort-without-comparator through the real YAML parser", async () => {
		vi.resetModules();
		mockAuxiliaryLspPublished.mockResolvedValue(false);
		vi.doUnmock("../../../../clients/dispatch/runners/yaml-rule-parser.js");
		vi.doUnmock("../../../../clients/package-root.js");
		// Earlier skip-path cases install per-test NAPI mocks. Replace any
		// lingering doMock registration with the package's real implementation.
		vi.doMock("@ast-grep/napi", async (importOriginal) => importOriginal());
		const env = setupTestEnvironment("pi-lens-ast-grep-real-rule-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const sorted = values.sort();\n");
			const mod =
				await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			expect(await mod.loadSg()).toBeDefined();

			const result = await mod.default.run(
				createCtx(filePath, {
					cwd: env.tmpDir,
					hasTool: async () => false,
				}) as any,
			);

			expect(result.status).toBe("succeeded");
			expect(result.diagnostics.map((diagnostic) => diagnostic.rule)).toContain(
				"no-sort-without-comparator",
			);
		} finally {
			env.cleanup();
		}
	}, 30_000);
});

describe("ast-grep-napi runner — metadata", () => {
	it("has expected runner id and appliesTo", async () => {
		vi.resetModules();
		const mod =
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
		const runner = mod.default;
		expect(runner.id).toBe("ast-grep-napi");
		expect(runner.appliesTo).toContain("jsts");
		expect(runner.enabledByDefault).toBe(true);
	});
});
