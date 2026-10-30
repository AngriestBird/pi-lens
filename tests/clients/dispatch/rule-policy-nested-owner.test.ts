/**
 * `rules.<id>` read from each file's config owner (#5010 review round 3).
 *
 * A nested `.pi-lens.json` governs the files under it on every surface that
 * filters by rule policy: the per-edit dispatcher (`createDispatchContext` →
 * `ctx.rulePolicy`), and the multi-file surfaces that take a
 * `loadProjectRulePolicy` (lens_diagnostics, lsp_diagnostics, the pushed and
 * inline-blocker finding policies). Everything below drives real config files
 * on disk and the real resolver; only the runners and the LSP service are
 * stand-ins.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { loadProjectRulePolicy } from "../../../clients/dispatch/finding-policy.js";
import { applyRulePolicy } from "../../../clients/dispatch/rule-policy.js";
import type {
	Diagnostic,
	RunnerDefinition,
	RunnerGroup,
} from "../../../clients/dispatch/types.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { clearWidgetState } from "../../../clients/widget-state.js";
import { createLensDiagnosticsTool } from "../../../tools/lens-diagnostics.js";
import { removeTempDirSync } from "../test-utils.js";
import { useConfigPath } from "../../support/global-config.js";
const setConfigPath = useConfigPath();

let tmpDir: string;
let repo: string;
let pkg: string;

function writeConfig(dir: string, config: unknown): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi-lens.json"), JSON.stringify(config));
}

function finding(filePath: string, rule = "no-eval"): Diagnostic {
	return {
		id: `${rule}:${filePath}`,
		message: rule,
		filePath,
		severity: "warning",
		semantic: "warning",
		tool: "ast-grep",
		rule,
		line: 1,
	};
}

function runnerReporting(diagnostics: Diagnostic[]): RunnerDefinition {
	return {
		id: "ast-grep",
		appliesTo: ["jsts"],
		priority: 10,
		async run() {
			return { status: "succeeded", diagnostics, semantic: "warning" };
		},
	};
}

/** Dispatch one file the way the pipeline does: `projectRoot` = the repo. */
async function dispatchUnderRepo(filePath: string): Promise<Diagnostic[]> {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "eval('1');\n");
	const registry = new RunnerRegistry();
	registry.register(runnerReporting([finding(filePath)]));
	const ctx = createDispatchContext(
		filePath,
		path.dirname(filePath),
		{ getFlag: () => false },
		new FactStore(),
		false,
		undefined,
		repo,
	);
	const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["ast-grep"] }];
	return (await dispatchForFile(ctx, groups, registry)).diagnostics;
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-owner-"));
	repo = path.join(tmpDir, "repo");
	pkg = path.join(repo, "pkg");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	setConfigPath(path.join(tmpDir, "global", "config.json"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	resetProjectLensConfigCache();
	removeTempDirSync(tmpDir);
});

describe("rules.<id> — dispatch reads the file's config owner", () => {
	it("control: with no nested rule the finding is delivered", async () => {
		writeConfig(pkg, { rules: { complexity: { threshold: 30 } } });

		const diagnostics = await dispatchUnderRepo(path.join(pkg, "a.ts"));

		expect(diagnostics.map((d) => d.rule)).toEqual(["no-eval"]);
	});

	it("drops a rule a nested .pi-lens.json disables", async () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });

		expect(await dispatchUnderRepo(path.join(pkg, "a.ts"))).toEqual([]);
	});

	it("leaves a file outside the nested owner under the repo's own policy", async () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });

		const diagnostics = await dispatchUnderRepo(path.join(repo, "a.ts"));

		expect(diagnostics.map((d) => d.rule)).toEqual(["no-eval"]);
	});

	it("still applies the repo root's policy to a file under the nested owner", async () => {
		writeConfig(repo, { rules: { "no-eval": { disable: ["no-eval"] } } });
		writeConfig(pkg, { rules: { complexity: { threshold: 30 } } });

		expect(await dispatchUnderRepo(path.join(pkg, "a.ts"))).toEqual([]);
	});

	it("matches a nested ignorePaths glob under the nested file's own directory", async () => {
		writeConfig(pkg, {
			rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
		});

		expect(await dispatchUnderRepo(path.join(pkg, "legacy", "a.ts"))).toEqual(
			[],
		);
		const kept = await dispatchUnderRepo(path.join(pkg, "src", "a.ts"));
		expect(kept.map((d) => d.rule)).toEqual(["no-eval"]);
	});
});

describe("rules.<id> — a project policy reads each file's own owner", () => {
	const inRoot = () => path.join(repo, "legacy", "b.ts");
	const inPkgGenerated = () => path.join(pkg, "legacy", "a.ts");
	const inPkgSrc = () => path.join(pkg, "src", "c.ts");

	function keptFiles(diagnostics: Diagnostic[]): string[] {
		return applyRulePolicy(diagnostics, loadProjectRulePolicy(repo), {
			root: repo,
			filePath: repo,
		}).map((d) => path.relative(repo, d.filePath));
	}

	it("applies a nested disable to that package's files only", () => {
		writeConfig(pkg, { rules: { "no-eval": { disable: ["no-eval"] } } });

		expect(keptFiles([finding(inRoot()), finding(inPkgSrc())])).toEqual([
			path.relative(repo, inRoot()),
		]);
	});

	it("anchors a nested ignorePaths glob at the nested file's directory", () => {
		writeConfig(pkg, {
			rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
		});

		expect(
			keptFiles([
				finding(inRoot()),
				finding(inPkgGenerated()),
				finding(inPkgSrc()),
			]),
		).toEqual([path.relative(repo, inRoot()), path.relative(repo, inPkgSrc())]);
	});

	it("keeps the same glob text from two files as two carve-outs", () => {
		writeConfig(repo, {
			rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
		});
		writeConfig(pkg, {
			rules: { "no-eval": { ignorePaths: ["legacy/**"] } },
		});

		expect(
			keptFiles([
				finding(inRoot()),
				finding(inPkgGenerated()),
				finding(inPkgSrc()),
			]),
		).toEqual([path.relative(repo, inPkgSrc())]);
	});
});

describe("rules.<id> — lens_diagnostics source=lsp reads each file's owner", () => {
	const MESSAGE = "Type 'string' is not assignable to type 'number'.";

	beforeEach(() => clearWidgetState());
	afterEach(() => clearWidgetState());

	async function probe(paths: string[]): Promise<string> {
		for (const file of paths) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "const value: number = 'bad';\n");
		}
		const service = {
			announceCreatedFiles: vi.fn(),
			sweepDocumentDrift: vi.fn(async () => undefined),
			touchFile: vi.fn(async () => ({
				diags: [
					{
						severity: 2,
						message: MESSAGE,
						source: "typescript",
						code: 2322,
						serverId: "typescript",
						range: {
							start: { line: 0, character: 6 },
							end: { line: 0, character: 11 },
						},
					},
				],
			})),
			getDiagnostics: vi.fn(async () => []),
			getCapabilitySnapshots: vi.fn(async () => []),
		};
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => repo,
			() => service as never,
		);
		const result = (await tool.execute(
			"diag-nested-owner",
			{ source: "lsp", scope: "paths", paths },
			new AbortController().signal,
			null,
			{ cwd: repo },
		)) as { content: Array<{ text: string }> };
		return result.content.map((part) => part.text).join("\n");
	}

	it("control: the repo root's own disable hides the finding", async () => {
		writeConfig(repo, { rules: { ts: { disable: ["typescript:2322"] } } });

		expect(await probe([path.join(repo, "app.ts")])).not.toContain(MESSAGE);
	});

	it("hides a finding a nested .pi-lens.json disables, and only under it", async () => {
		writeConfig(pkg, { rules: { ts: { disable: ["typescript:2322"] } } });

		expect(await probe([path.join(pkg, "app.ts")])).not.toContain(MESSAGE);
		expect(await probe([path.join(repo, "app.ts")])).toContain(MESSAGE);
	});
});
