/**
 * Dispatcher integration tests for project-level rule policy
 * (`rules.<id>.disable` / `rules.<id>.select`). Verifies the policy filter
 * runs at the END of the dispatcher pipeline (after inline suppression +
 * disposition) so the rendered `blockers` / `warnings` / `fixed` arrays
 * reflect the user's project policy, while the baseline still records the
 * full deduped set (a project rule edit does NOT corrupt delta baselines).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDispatchContext,
	dispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { RunnerRegistry } from "../../../clients/dispatch/dispatcher.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerGroup,
} from "../../../clients/dispatch/types.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { removeTempDirSync } from "../test-utils.js";

function makeContext(cwd: string, facts: FactStore): DispatchContext {
	return createDispatchContext(
		path.join(cwd, "a.ts"),
		cwd,
		{ getFlag: () => false },
		facts,
		false,
	);
}

function mockRunner(
	id: string,
	diagnostics: Diagnostic[],
): RunnerDefinition {
	return {
		id,
		appliesTo: ["jsts"],
		priority: 10,
		enabledByDefault: true,
		async run() {
			return {
				status: "succeeded",
				diagnostics,
				semantic: "warning",
			};
		},
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-policy-"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	resetProjectLensConfigCache();
});

describe("dispatcher filter — rules.<id>.disable", () => {
	it("drops a matching diagnostic from the rendered output", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);

		const diagnostics: Diagnostic[] = [
			{
				id: "no-eval-1",
				message: "no-eval",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "no-eval",
				line: 1,
			},
			{
				id: "no-debugger-1",
				message: "no-debugger",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "no-debugger",
				line: 2,
			},
		];

		const registry = new RunnerRegistry();
		registry.register(mockRunner("ast-grep", diagnostics));

		const ctx = makeContext(tmpDir, new FactStore());
		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["ast-grep"] },
		];

		const result = await dispatchForFile(ctx, groups, registry);
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["no-debugger"]);
		expect(result.warnings.map((d) => d.rule)).toEqual(["no-debugger"]);
	});

	it("drops the same rule under its LSP key (ast-grep: prefix) — normalization is shared", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);

		const diagnostics: Diagnostic[] = [
			{
				id: "ast-grep-no-eval",
				message: "no-eval (LSP tag)",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "ast-grep:no-eval",
				line: 1,
			},
		];

		const registry = new RunnerRegistry();
		registry.register(mockRunner("ast-grep", diagnostics));

		const ctx = makeContext(tmpDir, new FactStore());
		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["ast-grep"] },
		];

		const result = await dispatchForFile(ctx, groups, registry);
		expect(result.diagnostics).toHaveLength(0);
	});

	it("does NOT drop a rule that is not in any disable list", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);

		const diagnostics: Diagnostic[] = [
			{
				id: "no-debugger-1",
				message: "no-debugger",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "no-debugger",
				line: 1,
			},
		];

		const registry = new RunnerRegistry();
		registry.register(mockRunner("ast-grep", diagnostics));

		const ctx = makeContext(tmpDir, new FactStore());
		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["ast-grep"] },
		];

		const result = await dispatchForFile(ctx, groups, registry);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].rule).toBe("no-debugger");
	});

	it("warns nothing (no project config) — no drop, no warning", async () => {
		// No `.pi-lens.json` → no policy applies → keep everything.
		const diagnostics: Diagnostic[] = [
			{
				id: "no-eval-1",
				message: "no-eval",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "no-eval",
				line: 1,
			},
		];

		const registry = new RunnerRegistry();
		registry.register(mockRunner("ast-grep", diagnostics));

		const ctx = makeContext(tmpDir, new FactStore());
		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["ast-grep"] },
		];

		const result = await dispatchForFile(ctx, groups, registry);
		expect(result.diagnostics).toHaveLength(1);
	});
});

describe("dispatcher filter — rules.<id>.select", () => {
	it("keeps only diagnostics matching a project-wide select list", async () => {
		// Select is project-wide: the outer key (`no-eval`) is a grouping label
		// only, not a filter scope. A non-empty select ANYWHERE silences every
		// rule not listed, so `no-debugger` is dropped too even though it has
		// no policy entry of its own.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { select: ["no-eval"] } },
			}),
		);

		const diagnostics: Diagnostic[] = [
			{
				id: "no-eval-1",
				message: "no-eval",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "no-eval",
				line: 1,
			},
			{
				id: "no-debugger-1",
				message: "no-debugger",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "no-debugger",
				line: 2,
			},
		];

		const registry = new RunnerRegistry();
		registry.register(mockRunner("ast-grep", diagnostics));

		const ctx = makeContext(tmpDir, new FactStore());
		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["ast-grep"] },
		];

		const result = await dispatchForFile(ctx, groups, registry);
		// Only `no-eval` survives — it's the sole entry in the project-wide
		// select union. `no-debugger` is dropped even though it isn't
		// configured under any key.
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["no-eval"]);
	});

	it("drops a diagnostic when select is configured but has no matching entry", async () => {
		// The select list is `["no-debugger"]` — `no-eval` is NOT in the
		// union, so it's dropped via the inverted-select rule.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { select: ["no-debugger"] } },
			}),
		);

		const diagnostics: Diagnostic[] = [
			{
				id: "no-eval-1",
				message: "no-eval",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "no-eval",
				line: 1,
			},
		];

		const registry = new RunnerRegistry();
		registry.register(mockRunner("ast-grep", diagnostics));

		const ctx = makeContext(tmpDir, new FactStore());
		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["ast-grep"] },
		];

		const result = await dispatchForFile(ctx, groups, registry);
		expect(result.diagnostics).toHaveLength(0);
	});

	it("disable wins over select on the same rule key", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: {
					"no-eval": { disable: ["no-eval"], select: ["no-eval"] },
				},
			}),
		);

		const diagnostics: Diagnostic[] = [
			{
				id: "no-eval-1",
				message: "no-eval",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "no-eval",
				line: 1,
			},
		];

		const registry = new RunnerRegistry();
		registry.register(mockRunner("ast-grep", diagnostics));

		const ctx = makeContext(tmpDir, new FactStore());
		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["ast-grep"] },
		];

		const result = await dispatchForFile(ctx, groups, registry);
		expect(result.diagnostics).toHaveLength(0);
	});
});

describe("dispatcher filter — threshold-only entries", () => {
	it("threshold-only entries do NOT filter output (separate concern)", async () => {
		// A `threshold: 25` entry is consumed by the rule evaluator, not the
		// policy filter. The dispatcher should not interpreted it as a policy.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "high-complexity": { threshold: 25 } },
			}),
		);

		const diagnostics: Diagnostic[] = [
			{
				id: "no-eval-1",
				message: "no-eval",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "no-eval",
				line: 1,
			},
		];

		const registry = new RunnerRegistry();
		registry.register(mockRunner("ast-grep", diagnostics));

		const ctx = makeContext(tmpDir, new FactStore());
		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["ast-grep"] },
		];

		const result = await dispatchForFile(ctx, groups, registry);
		expect(result.diagnostics).toHaveLength(1);
	});
});

describe("dispatcher filter — blockers and warnings", () => {
	it("a disable'd rule is dropped from blockers too (not just warnings)", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);

		const diagnostics: Diagnostic[] = [
			{
				id: "no-eval-1",
				message: "no-eval",
				filePath: path.join(tmpDir, "a.ts"),
				severity: "error",
				semantic: "blocking",
				tool: "ast-grep",
				rule: "no-eval",
				line: 1,
			},
		];

		const registry = new RunnerRegistry();
		registry.register(mockRunner("ast-grep", diagnostics));

		const ctx = makeContext(tmpDir, new FactStore());
		const groups: RunnerGroup[] = [
			{ mode: "all", runnerIds: ["ast-grep"] },
		];

		const result = await dispatchForFile(ctx, groups, registry);
		expect(result.diagnostics).toHaveLength(0);
		expect(result.blockers).toHaveLength(0);
		expect(result.hasBlockers).toBe(false);
	});
});

describe("dispatcher filter — resolves the policy from the project root, not the language root", () => {
	it("applies a repo-root policy even when the edited file's nested package has its own .pi-lens.json", async () => {
		// `ctx.projectConfig` resolves from `resolveLanguageRootForFile` (the
		// nested package dir in a monorepo) — the rule-policy map must NOT be
		// derived from it, since `discoverPiLensProjectConfig`'s upward walk
		// stops at the FIRST config found and would shadow the repo root's
		// policy entirely. `lens_diagnostics` loads its policy map from
		// `runtime.projectRoot`; the dispatcher must resolve the same way.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		const pkgDir = path.join(tmpDir, "packages", "pkg-a");
		fs.mkdirSync(pkgDir, { recursive: true });
		fs.writeFileSync(
			path.join(pkgDir, "package.json"),
			JSON.stringify({ name: "pkg-a" }),
		);
		// A nested config exists but defines no rule policy of its own — without
		// the fix, this config (found first by the upward walk from the nested
		// language root) would shadow the root's policy outright.
		fs.writeFileSync(
			path.join(pkgDir, ".pi-lens.json"),
			JSON.stringify({ rules: { "high-complexity": { threshold: 30 } } }),
		);

		const filePath = path.join(pkgDir, "a.ts");
		const diagnostics: Diagnostic[] = [
			{
				id: "no-eval-1",
				message: "no-eval",
				filePath,
				severity: "warning",
				semantic: "warning",
				tool: "ast-grep",
				rule: "no-eval",
				line: 1,
			},
		];

		const registry = new RunnerRegistry();
		registry.register(mockRunner("ast-grep", diagnostics));

		const ctx = createDispatchContext(
			filePath,
			tmpDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);
		// Confirm the language root actually resolved to the nested package —
		// otherwise this test wouldn't be exercising the bug at all.
		expect(ctx.cwd).toBe(pkgDir);
		expect(ctx.projectRoot).toBe(tmpDir);

		const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["ast-grep"] }];
		const result = await dispatchForFile(ctx, groups, registry);
		expect(result.diagnostics).toHaveLength(0);
	});
});
