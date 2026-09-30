/**
 * #3598: `cargo clippy --fix` rewrites every fixable file of the crate, but the
 * pipeline's hold on pi's file-mutation queue covers only the edited target.
 * An agent edit to a SIBLING file that lands while clippy runs was erased by
 * clippy's later write (the tool had read the file before the edit).
 *
 * The real `runPipeline` and its Rust autofix path run, and the real
 * `handleToolResult` delivers the agent's edit. Only the process boundary is
 * faked: `cargo clippy --fix` is a gated double that rewrites sibling files at
 * a moment the test chooses, so each interleaving is pinned with gates rather
 * than timers.
 *
 * Recurrence guarded: an agent edit erased by a whole-package fixer that pi's
 * queue cannot see (#3541's remainder), and the same edit lost silently when
 * the capture itself was already overwritten.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import type { BiomeClient } from "../../clients/biome-client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { MetricsClient } from "../../clients/metrics-client.js";
import {
	type PipelineContext,
	type PipelineDeps,
	runPipeline,
} from "../../clients/pipeline.js";
import type { RuffClient } from "../../clients/ruff-client.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import {
	beginFixRun,
	FIX_RUN_MAX_FILE_BYTES,
} from "../../clients/fix-run-restore.js";
import {
	type MutationBridgeDeps,
	recordMutationThroughSeam,
} from "../../clients/mutation-bridge.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { setupTestEnvironment } from "./test-utils.js";

const fake = vi.hoisted(() => ({
	/** The body of the fake `cargo clippy --fix`; it runs where clippy would. */
	clippy: undefined as undefined | ((cwd: string) => Promise<number>),
	/** The body of the fake `dart fix --apply`. */
	dartFix: undefined as undefined | ((cwd: string) => Promise<number>),
}));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: vi.fn(
			async (
				command: string,
				args: readonly string[],
				options?: Parameters<typeof actual.safeSpawnAsync>[2],
			) => {
				if (command === "cargo" && args[0] === "--version") {
					return { stdout: "cargo 1.82.0", stderr: "", status: 0 };
				}
				if (command === "cargo" && args[0] === "clippy") {
					const status = (await fake.clippy?.(options?.cwd ?? "")) ?? 0;
					return { stdout: "", stderr: "", status };
				}
				if (command === "dart" && args[0] === "--version") {
					return { stdout: "Dart SDK version: 3.5.0", stderr: "", status: 0 };
				}
				if (command === "dart" && args[0] === "fix") {
					const status = (await fake.dartFix?.(options?.cwd ?? "")) ?? 0;
					return { stdout: "", stderr: "", status };
				}
				return actual.safeSpawnAsync(command, [...args], options);
			},
		),
	};
});

vi.mock("../../clients/dispatch/integration.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dispatch/integration.js")
	>()),
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));
import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";

vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(),
}));
import { getLSPService } from "../../clients/lsp/index.js";

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

const ORIGINAL = "pub fn f() { let x = 1; }\n";
const TOOL_FIXED = "pub fn f() { let _x = 1; }\n";
const KIND = "fix-run-agent-edit-overwritten";

describe("whole-package fixer restores agent edits (#3598)", () => {
	let tmpDir: string;
	let cleanup: () => void;
	let srcDir: string;
	let mainRs: string;
	let previousDebounce: string | undefined;

	beforeEach(() => {
		resetDegradationLedger();
		previousDebounce = process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "0";
		const env = setupTestEnvironment("pi-lens-fix-run-restore-");
		tmpDir = env.tmpDir;
		cleanup = env.cleanup;
		const crateDir = path.join(tmpDir, "crate");
		srcDir = path.join(crateDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			path.join(crateDir, "Cargo.toml"),
			'[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[workspace]\nmembers = ["crate"]\n',
		);
		mainRs = path.join(srcDir, "main.rs");
		fs.writeFileSync(mainRs, "mod a;\nmod b;\nfn main() {}\n");
		fs.writeFileSync(path.join(srcDir, "a.rs"), ORIGINAL);
		fs.writeFileSync(path.join(srcDir, "b.rs"), ORIGINAL);
		vi.mocked(getLSPService).mockReturnValue(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
			}) as never,
		);
		vi.mocked(dispatchLintWithResult).mockReset();
		vi.mocked(dispatchLintWithResult).mockResolvedValue({
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
			hasBlockers: false,
		});
	});

	afterEach(() => {
		fake.clippy = undefined;
		fake.dartFix = undefined;
		if (previousDebounce === undefined)
			delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		else process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = previousDebounce;
		cleanup();
	});

	function pipelineDeps(): PipelineDeps {
		return {
			biomeClient: {
				isSupportedFile: () => true,
				ensureAvailable: async () => false,
				fixFileAsync: async () => ({ success: true, changed: false, fixed: 0 }),
			} as unknown as BiomeClient,
			ruffClient: {
				isPythonFile: () => false,
				ensureAvailable: async () => false,
			} as unknown as RuffClient,
			testRunnerClient: new TestRunnerClient(),
			metricsClient: new MetricsClient(),
			getFormatService: () => ({}) as never,
			fixedThisTurn: new Set(),
		} as PipelineDeps;
	}

	function pipelineContext(filePath: string): PipelineContext {
		return {
			filePath,
			cwd: tmpDir,
			toolName: "write",
			getFlag: () => false,
			dbg: () => {},
		};
	}

	/**
	 * The agent's own `edit` of `file`, delivered the way pi delivers it: the
	 * host tool writes the file, then the real tool_result handler runs.
	 * `write` is separate from `deliver` so a test can put the fixer's write
	 * between the two.
	 */
	function agentEdit(file: string, newText: string) {
		return {
			write: () => fs.writeFileSync(file, `${newText}\n`),
			deliver: async () => {
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = tmpDir;
				runtime.setTelemetryIdentity({ sessionId: "fix-run-restore" });
				runtime.beginTurn();
				await handleToolResult({
					event: {
						toolName: "edit",
						input: {
							path: file,
							edits: [{ oldText: "let x = 1;", newText }],
						},
						details: {},
						content: [{ type: "text", text: "ok" }],
					},
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					biomeClient: {},
					ruffClient: {},
					testRunnerClient: {},
					metricsClient: {},
					resetLSPService: () => {},
					agentBehaviorRecord: () => [],
					formatBehaviorWarnings: () => "",
				} as unknown as Parameters<typeof handleToolResult>[0]);
			},
		};
	}

	function overwrittenCount(): number {
		return (
			getDegradationSummary().find((group) => group.kind === KIND)?.count ?? 0
		);
	}

	it("keeps an agent edit to a sibling file that landed during the run", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		proceed.open();
		const result = await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(result.changedFiles ?? []).not.toContain(aRs);
		expect(overwrittenCount()).toBe(1);
	});

	it("leaves the tool's fix on a sibling the agent did not edit", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const bRs = path.join(srcDir, "b.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			fs.writeFileSync(bRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		proceed.open();
		const result = await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(fs.readFileSync(bRs, "utf-8")).toBe(TOOL_FIXED);
		expect(result.changedFiles).toContain(bRs);
	});

	it("does not rewrite a sibling the agent edited and the tool did not touch", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		// A fixed old mtime: any rewrite after this moves it.
		fs.utimesSync(aRs, 1_000_000, 1_000_000);
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(fs.statSync(aRs).mtimeMs).toBe(1_000_000_000);
		expect(overwrittenCount()).toBe(0);
	});

	it("leaves a file the tool created alone", async () => {
		const created = path.join(srcDir, "generated.rs");
		const started = gate();
		const created$ = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			fs.writeFileSync(created, "let x = 1;\n// created by the tool\n");
			created$.open();
			await proceed.p;
			fs.writeFileSync(created, "// tool rewrote its own file\n");
			return 0;
		};

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		await created$.p;
		// The agent edits the tool's new file during the run. It was not in the
		// pre-run set, so nothing is captured and the tool's rewrite stands.
		const edit = agentEdit(created, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		proceed.open();
		await run;

		expect(fs.readFileSync(created, "utf-8")).toBe(
			"// tool rewrote its own file\n",
		);
		expect(overwrittenCount()).toBe(0);
	});

	it("restores the agent edit even when the tool exits nonzero after writing", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 101;
		};

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(overwrittenCount()).toBe(1);
	});

	it("records exactly one degradation for a run that overwrote several edits", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const bRs = path.join(srcDir, "b.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			fs.writeFileSync(bRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		for (const file of [aRs, bRs]) {
			const edit = agentEdit(file, "let AGENT = 1;");
			edit.write();
			await edit.deliver();
		}
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(fs.readFileSync(bRs, "utf-8")).toBe("let AGENT = 1;\n");
		expect(overwrittenCount()).toBe(1);
	});

	it("reports a lost edit by file name when the tool wrote before the capture", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			return 0;
		};

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		// The agent's host tool wrote a.rs; the fixer then wrote its stale-based
		// content; only THEN does pi-lens's tool_result read the file.
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		fs.writeFileSync(aRs, TOOL_FIXED);
		await edit.deliver();
		proceed.open();
		const result = await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe(TOOL_FIXED);
		expect(result.output).toContain("a.rs");
		expect(result.output).toContain("re-apply");
		expect(overwrittenCount()).toBe(1);
	});

	it("keeps an edit recorded through the mutation bridge that landed during the run", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		// An observed or third-party producer: no tool input, so the capture is
		// taken unverified, and it still survives the fixer's later write.
		fs.writeFileSync(aRs, "let BRIDGED = 1;\n");
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "fix-run-restore-bridge" });
		runtime.beginTurn();
		const deps: MutationBridgeDeps = {
			getRuntime: () => runtime as never,
			getCacheManager: () => new CacheManager(false),
			getProjectRoot: () => tmpDir,
			getDispatchCwd: () => tmpDir,
			countFileLines,
			isRecordable: () => true,
			dbg: () => {},
		};
		expect(
			recordMutationThroughSeam({ filePath: aRs, kind: "edit" }, deps),
		).toBe(true);
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe("let BRIDGED = 1;\n");
		expect(overwrittenCount()).toBe(1);
	});

	it("does not restore over a fix when the delivered edit left the bytes unchanged", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const started = gate();
		const proceed = gate();
		fake.clippy = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		const run = runPipeline(pipelineContext(mainRs), pipelineDeps());
		await started.p;
		// An edit whose result equals the pre-run bytes is not a change to protect.
		const edit = agentEdit(aRs, "let x = 1;");
		fs.writeFileSync(aRs, ORIGINAL);
		await edit.deliver();
		proceed.open();
		await run;

		expect(fs.readFileSync(aRs, "utf-8")).toBe(TOOL_FIXED);
		expect(overwrittenCount()).toBe(0);
	});

	it("leaves the tool's fix over an agent edit that landed before the run", async () => {
		const aRs = path.join(srcDir, "a.rs");
		const edit = agentEdit(aRs, "let AGENT = 1;");
		edit.write();
		await edit.deliver();
		fake.clippy = async () => {
			fs.writeFileSync(aRs, TOOL_FIXED);
			return 0;
		};

		await runPipeline(pipelineContext(mainRs), pipelineDeps());

		expect(fs.readFileSync(aRs, "utf-8")).toBe(TOOL_FIXED);
		expect(overwrittenCount()).toBe(0);
	});

	it("keeps an agent edit to a Dart sibling during dart fix --apply", async () => {
		const libDir = path.join(tmpDir, "pkg", "lib");
		fs.mkdirSync(libDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, "pkg", "pubspec.yaml"),
			"name: fixture\nenvironment:\n  sdk: ^3.5.0\n",
		);
		// The agreement evidence is anchored at the pipeline cwd (#3005 fixture
		// recurrence, as the Cargo.toml above).
		fs.writeFileSync(path.join(tmpDir, "pubspec.yaml"), "name: root\n");
		const mainDart = path.join(libDir, "main.dart");
		const aDart = path.join(libDir, "a.dart");
		fs.writeFileSync(mainDart, "void main() {}\n");
		fs.writeFileSync(aDart, "int a() => 1;\n");
		const started = gate();
		const proceed = gate();
		fake.dartFix = async () => {
			started.open();
			await proceed.p;
			fs.writeFileSync(aDart, "int a() => 1; // tool\n");
			return 0;
		};

		const run = runPipeline(pipelineContext(mainDart), pipelineDeps());
		await started.p;
		fs.writeFileSync(aDart, "int a() => AGENT;\n");
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "fix-run-restore-dart" });
		runtime.beginTurn();
		await handleToolResult({
			event: {
				toolName: "write",
				input: { path: aDart, content: "int a() => AGENT;\n" },
				details: {},
				content: [{ type: "text", text: "ok" }],
			},
			getFlag: (flag: string) => flag === "no-autofix",
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			testRunnerClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as unknown as Parameters<typeof handleToolResult>[0]);
		proceed.open();
		await run;

		expect(fs.readFileSync(aDart, "utf-8")).toBe("int a() => AGENT;\n");
		expect(overwrittenCount()).toBe(1);
	});
});

describe("fix-run hash scope (#3598)", () => {
	let dir: string;
	let cleanup: () => void;
	beforeEach(() => {
		resetDegradationLedger();
		const env = setupTestEnvironment("pi-lens-fix-run-scope-");
		dir = env.tmpDir;
		cleanup = env.cleanup;
	});
	afterEach(() => cleanup());

	it("covers only the tool's extension and records a cut set once", async () => {
		const rs = path.join(dir, "a.rs");
		const big = path.join(dir, "big.rs");
		const md = path.join(dir, "notes.md");
		fs.writeFileSync(rs, "fn a() {}\n");
		fs.writeFileSync(big, "x".repeat(FIX_RUN_MAX_FILE_BYTES + 1));
		fs.writeFileSync(md, "# not source\n");

		const run = await beginFixRun({
			tool: "rust-clippy",
			extension: ".rs",
			candidates: [rs, big, md],
		});
		const report = await run.finish();

		expect(report).toEqual({ restored: [], lost: [], agentEdited: [] });
		const cut = getDegradationSummary().find(
			(group) => group.kind === "fix-run-scope-truncated",
		);
		// One file over the size cap; the markdown file was never a candidate.
		expect(cut?.count).toBe(1);
		expect(cut?.latestReasons[0]?.reason).toContain("1 of 2 .rs file(s)");
	});

	it("stops hashing at the byte budget", async () => {
		const files = ["a.rs", "b.rs", "c.rs"].map((name) => path.join(dir, name));
		for (const file of files) fs.writeFileSync(file, "12345678");

		const run = await beginFixRun({
			tool: "rust-clippy",
			extension: ".rs",
			candidates: files,
			byteBudget: 16,
		});
		await run.finish();

		const cut = getDegradationSummary().find(
			(group) => group.kind === "fix-run-scope-truncated",
		);
		expect(cut?.latestReasons[0]?.reason).toContain("1 of 3 .rs file(s)");
	});
});
