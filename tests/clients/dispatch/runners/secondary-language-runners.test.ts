import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
let availabilityCheck: (command: string) => boolean = () => true;

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => availabilityCheck(command),
			isAvailableAsync: async () => availabilityCheck(command),
			getCommand: () => command,
		}),
	}),
);

function mockRunnerHelpers(
	isAvailable: (command: string) => boolean = () => true,
): void {
	availabilityCheck = isAvailable;
}

function createCtx(
	kind: "dart" | "zig" | "gleam" | "elixir",
	filePath: string,
	cwd: string,
) {
	return makeRunnerCtx(filePath, cwd, { kind });
}

async function dispatchOutcome(
	tool: "dart-analyze" | "elixir-check",
	caseName: string,
	spawnResult: {
		error?: Error | null;
		status: number | null;
		signal?: NodeJS.Signals | null;
		stdout: string;
		stderr: string;
	},
	options: { available?: boolean } = {},
) {
	vi.resetModules();
	const env = setupTestEnvironment(`pi-lens-${tool}-${caseName}-`);
	try {
		const kind = tool === "dart-analyze" ? "dart" : "elixir";
		const extension = kind === "dart" ? "main.dart" : "lib/app.ex";
		const filePath = path.join(env.tmpDir, extension);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			kind === "dart" ? "void main() {}\n" : "defmodule App do\n",
		);
		if (kind === "elixir") {
			fs.writeFileSync(
				path.join(env.tmpDir, "mix.exs"),
				"defmodule Demo.MixProject do end\n",
			);
		}

		mockRunnerHelpers(() => options.available ?? true);
		if (options.available ?? true)
			safeSpawnAsync.mockResolvedValue(spawnResult);
		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const runner = (
			await import(`../../../../clients/dispatch/runners/${tool}.js`)
		).default;
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../../../clients/degradation-ledger.js");
		resetDegradationLedger();
		const registry = new RunnerRegistry();
		registry.register(runner);
		let observedStatus: string | undefined;
		let observedDiagnostics: Array<{ id?: string }> = [];
		const result = await dispatchForFile(
			createDispatchContext(
				filePath,
				env.tmpDir,
				{ getFlag: () => false },
				new FactStore(),
			),
			[{ mode: "all", runnerIds: [tool] }],
			registry,
			(_runnerId, runnerResult) => {
				observedStatus = runnerResult.status;
				observedDiagnostics = runnerResult.diagnostics;
			},
		);
		return {
			status: observedStatus,
			diagnostics: observedDiagnostics,
			output: result.output,
			ledger: getDegradationSummary(),
			spawnCalls: safeSpawnAsync.mock.calls.length,
		};
	} finally {
		env.cleanup();
	}
}

describe("secondary language fallback runners", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		availabilityCheck = () => true;
		mockRunnerHelpers();
	});

	it("surfaces a warning when dart analyze exits non-zero without machine diagnostics", async () => {
		const env = setupTestEnvironment("pi-lens-dart-runner-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "main.dart");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "void main() {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "dart analyze failed unexpectedly",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/dart-analyze.js")
			).default;

			const result = await runner.run(
				createCtx("dart", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.id).toBe("dart-analyze:parse-error:1");
		} finally {
			env.cleanup();
		}
	});

	it("preserves dart findings on a nonzero run and keeps exit-0 stderr noise clean (#1816)", async () => {
		const env = setupTestEnvironment("pi-lens-dart-outcomes-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "main.dart");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "void main() {}\n");
			const runner = (
				await import("../../../../clients/dispatch/runners/dart-analyze.js")
			).default;

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: "",
				stderr: `ERROR|LINT|unused_local_variable|${filePath}|2|1|1|unused value`,
			});
			const findings = await runner.run(
				createCtx("dart", filePath, env.tmpDir) as never,
			);
			expect(findings.status).toBe("failed");
			expect(findings.diagnostics).toHaveLength(1);

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: "",
				stderr: "dart analyze: no issues\n",
			});
			const clean = await runner.run(
				createCtx("dart", filePath, env.tmpDir) as never,
			);
			expect(clean).toMatchObject({
				status: "succeeded",
				diagnostics: [],
				semantic: "none",
			});
		} finally {
			env.cleanup();
		}
	});

	it("does not turn a signaled dart run into success (#1816)", async () => {
		const env = setupTestEnvironment("pi-lens-dart-signal-");
		try {
			const filePath = path.join(env.tmpDir, "main.dart");
			fs.writeFileSync(filePath, "void main() {}\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: null,
				signal: "SIGTERM",
				stdout: "",
				stderr: "",
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/dart-analyze.js")
			).default;
			const result = await runner.run(
				createCtx("dart", filePath, env.tmpDir) as never,
			);
			expect(result.status).toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	it("falls back to flutter analyze when dart is unavailable", async () => {
		vi.resetModules();
		mockRunnerHelpers((command) => command === "flutter");

		const env = setupTestEnvironment("pi-lens-dart-flutter-runner-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "main.dart");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "void main() {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: `warning|static_warning|unused_import|${filePath}|2|1|1|Unused import`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/dart-analyze.js")
			).default;

			const result = await runner.run(
				createCtx("dart", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(safeSpawnAsync.mock.calls[0]?.[0]).toBe("flutter");
		} finally {
			env.cleanup();
		}
	});

	it("guards dart rejection through dispatch (#1816)", async () => {
		// Prevents a rejected dart invocation from becoming a clean rendered result.
		const observed = await dispatchOutcome("dart-analyze", "rejected", {
			error: null,
			status: 2,
			stdout: "",
			stderr: "unknown dart analyze option",
		});
		expect(observed.status).toBe("failed");
		expect(observed.diagnostics[0]?.id).toBe("dart-analyze:parse-error:1");
		expect(observed.ledger[0]?.kind).toBe("runner-parsed-nothing");
	});

	it("guards dart empty output through dispatch (#1816)", async () => {
		// Prevents a failed Dart run with no parser input from becoming clean.
		const observed = await dispatchOutcome("dart-analyze", "empty", {
			error: null,
			status: 1,
			stdout: "",
			stderr: "",
		});
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.ledger[0]?.latestReasons[0]?.reason).toContain("no output");
	});

	it("guards actual dart unavailability through dispatch (#1816)", async () => {
		// Prevents absent dart and flutter binaries from being reported as clean.
		const observed = await dispatchOutcome(
			"dart-analyze",
			"unavailable",
			{ error: null, status: 0, stdout: "", stderr: "" },
			{ available: false },
		);
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.spawnCalls).toBe(0);
		expect(observed.ledger).toEqual([]);
	});

	it("surfaces a warning when zig exits non-zero without structured diagnostics", async () => {
		const env = setupTestEnvironment("pi-lens-zig-runner-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main.zig");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() void {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "zig failed before emitting diagnostics",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/zig-check.js")
			).default;

			const result = await runner.run(
				createCtx("zig", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.message).toContain("zig failed");
		} finally {
			env.cleanup();
		}
	});

	it("keeps context-free zig compiler diagnostics non-blocking", async () => {
		const env = setupTestEnvironment("pi-lens-zig-contextless-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main.zig");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() void {}\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: `${filePath}:2:1: error: unable to load module`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/zig-check.js")
			).default;
			const result = await runner.run(
				createCtx("zig", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});

	it("surfaces a blocking diagnostic when gleam exits non-zero without structured output", async () => {
		const env = setupTestEnvironment("pi-lens-gleam-runner-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.gleam");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() { Nil }\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "gleam check failed unexpectedly",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/gleam-check.js")
			).default;

			const result = await runner.run(
				createCtx("gleam", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.message).toContain("gleam check failed");
		} finally {
			env.cleanup();
		}
	});

	it("surfaces a blocking diagnostic when elixir compile exits non-zero without structured output", async () => {
		const env = setupTestEnvironment("pi-lens-elixir-runner-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "app.ex");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, "mix.exs"),
				"defmodule Demo.MixProject do end\n",
			);
			fs.writeFileSync(filePath, "defmodule App do\n");

			// mix availability is now answered by the mocked createAvailabilityChecker
			// (#120), so only the actual `mix compile` spawn needs mocking here.
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: "",
				stderr: "elixir compiler failed before emitting diagnostics",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/elixir-check.js")
			).default;

			const result = await runner.run(
				createCtx("elixir", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.id).toBe("elixir-check:parse-error:1");
		} finally {
			env.cleanup();
		}
	});

	it("guards elixir empty output through dispatch (#1816)", async () => {
		// Prevents a failed Mix run with no parser input from becoming clean.
		const observed = await dispatchOutcome("elixir-check", "empty", {
			error: null,
			status: 1,
			stdout: "",
			stderr: "",
		});
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.ledger[0]?.latestReasons[0]?.reason).toContain("no output");
	});

	it("guards elixir signal termination through dispatch (#1816)", async () => {
		// Prevents a signal-killed Mix run from becoming a clean rendered result.
		const observed = await dispatchOutcome("elixir-check", "signal", {
			error: null,
			status: null,
			signal: "SIGTERM",
			stdout: "",
			stderr: "",
		});
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.ledger[0]?.latestReasons[0]?.reason).toContain("SIGTERM");
	});

	it("keeps elixir status-0 stderr noise clean through dispatch (#1816)", async () => {
		// Prevents harmless Mix stderr noise from becoming a false diagnostic.
		const observed = await dispatchOutcome("elixir-check", "stderr-noise", {
			error: null,
			status: 0,
			stdout: "",
			stderr: "Compiling 1 file (.ex)\n",
		});
		expect(observed.status).toBe("succeeded");
		expect(observed.output).toBe("");
		expect(observed.ledger).toEqual([]);
	});

	it("guards elixir rejection through dispatch (#1816)", async () => {
		// Prevents a rejected Mix invocation from becoming a clean rendered result.
		const observed = await dispatchOutcome("elixir-check", "rejected", {
			error: null,
			status: 2,
			stdout: "",
			stderr: "unknown Mix option",
		});
		expect(observed.status).toBe("failed");
		expect(observed.diagnostics[0]?.id).toBe("elixir-check:parse-error:1");
		expect(observed.ledger[0]?.kind).toBe("runner-parsed-nothing");
	});

	it("guards actual elixir unavailability through dispatch (#1816)", async () => {
		// Prevents absent Mix and elixirc binaries from being reported as clean.
		const observed = await dispatchOutcome(
			"elixir-check",
			"unavailable",
			{ error: null, status: 0, stdout: "", stderr: "" },
			{ available: false },
		);
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.spawnCalls).toBe(0);
		expect(observed.ledger).toEqual([]);
	});

	it("real dispatcher renders an elixir nonzero finding (#1816)", async () => {
		const env = setupTestEnvironment("pi-lens-elixir-dispatch-witness-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "app.ex");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, "mix.exs"),
				"defmodule Demo.MixProject do end\n",
			);
			fs.writeFileSync(filePath, "defmodule App do\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: `** (SyntaxError) lib/app.ex:1:1: unexpected end of file`,
			});
			const { createDispatchContext, dispatchForFile, RunnerRegistry } =
				await import("../../../../clients/dispatch/dispatcher.js");
			const runner = (
				await import("../../../../clients/dispatch/runners/elixir-check.js")
			).default;
			const registry = new RunnerRegistry();
			registry.register(runner);
			let observedStatus: string | undefined;
			const result = await dispatchForFile(
				createDispatchContext(
					filePath,
					env.tmpDir,
					{ getFlag: () => false },
					new FactStore(),
				),
				[{ mode: "all", runnerIds: ["elixir-check"] }],
				registry,
				(_runnerId, runnerResult) => {
					observedStatus = runnerResult.status;
				},
			);
			expect(observedStatus).toBe("failed");
			expect(result.output).toContain("🔴 STOP — 1 issue(s) must be fixed:");
			await expect(result.output).toMatchFileSnapshot(
				"../../../fixtures/witness/runner-outcome-dart-analyze-elixir-check/elixir-nonzero-findings.txt",
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps standalone elixirc diagnostics non-blocking", async () => {
		const env = setupTestEnvironment("pi-lens-elixirc-contextless-");
		try {
			const filePath = path.join(env.tmpDir, "app.ex");
			fs.writeFileSync(filePath, "defmodule App do\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "** (CompileError) app.ex:1:1: module Dependency is not loaded",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/elixir-check.js")
			).default;
			const result = await runner.run(
				createCtx("elixir", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});
});
