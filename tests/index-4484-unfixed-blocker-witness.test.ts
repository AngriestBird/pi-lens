// flake-shape: in-process-mock — clients/lsp/capabilities stands in for the language-server process (the LSP double computes diagnostics from the bytes it is handed); every other pi-lens module on the chain is real
/**
 * #4484 witness (ADR 0007): a second write must not clear a blocker it left
 * in place.
 *
 * Recurrence it prevents: write 1 introduces error E, write 2 changes another
 * line, the delta calls E "not new", and pi-lens then said `✓ clean`, opened
 * the --lens-guard commit gate, emptied the session store and the widget, and
 * reported E as "cleared by the 2nd write" at turn end, while E was still on
 * disk. The same happened across turns and for a linter with ordinal ids
 * (helm-lint), where a line shift or a fix of an earlier finding keeps or
 * moves an id.
 *
 * Real: `index.ts`'s registered handlers (session_start, turn_start,
 * tool_result, tool_call, turn_end, context), `handleToolResult`,
 * `runPipeline`, `dispatchForFile` with the real `lsp` and `helm-lint`
 * runners, `RuntimeCoordinator`, `handleTurnEnd`, the git-guard gate,
 * `lens_diagnostics` and the widget store. Doubled only at the process
 * boundaries, the #3190 witness shape: `clients/safe-spawn.js` (helm) and the
 * LSP service behind `clients/lsp/capabilities.js`, whose `touchFile` reports
 * error 2304 on every line containing `BAD_CALL`, so it tracks the bytes like
 * a server would.
 *
 * Cells share one project directory: `index.ts`'s module graph is a process
 * singleton, and a session started in a second directory delivered nothing in
 * the probe. Each cell uses its own file and its own session, and ends by
 * fixing its file so no record or gate state reaches the next cell.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const boundary = vi.hoisted(() => {
	const lsp = {
		/** The fake language server: error 2304 on each `BAD_CALL` line. */
		diagnose: (content: string): unknown[] =>
			content.split("\n").flatMap((line, i) =>
				line.includes("BAD_CALL")
					? [
							{
								severity: 1,
								message: "Cannot find name 'BAD_CALL'.",
								code: 2304,
								source: "ts",
								serverId: "typescript",
								range: {
									start: { line: i, character: 0 },
									end: { line: i, character: 8 },
								},
							},
						]
					: [],
			),
		enabled: false,
		touches: 0,
		/**
		 * The double's touchFile. It lives here, not in the `vi.mock` factory:
		 * `tests/config/vi-mock-export-sweep.test.ts` reads a factory's export
		 * list off the first `return` it finds (the #3190 witness's note).
		 */
		touch: async (_file: string, content: string) => {
			lsp.touches += 1;
			return { diags: lsp.diagnose(content) };
		},
	};
	const helm = { stdout: "", lintCalls: 0 };
	const isHelm = (c: string) => /(^|[\\/])helm(\.exe)?$/i.test(c);
	function run(command: string, args: readonly string[] = []) {
		if (!isHelm(command))
			return {
				stdout: "",
				stderr: "command not found",
				status: 127,
				failure: "spawn" as const,
				spawnFailure: { kind: "tool-not-found" as const },
			};
		if (args[0] === "lint") {
			helm.lintCalls += 1;
			return {
				stdout: helm.stdout,
				stderr: helm.stdout
					? "Error: 1 chart(s) linted, 1 chart(s) failed"
					: "",
				status: helm.stdout ? 1 : 0,
			};
		}
		return {
			stdout: 'version.BuildInfo{Version:"v3.16.2"}',
			stderr: "",
			status: 0,
		};
	}
	return { lsp, helm, isHelm, run };
});

vi.mock("../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/safe-spawn.js")>()),
	safeSpawn: boundary.run,
	safeSpawnAsync: async (command: string, args: readonly string[] = []) =>
		boundary.run(command, args),
	isCommandAvailable: boundary.isHelm,
	isCommandAvailableAsync: async (command: string) => boundary.isHelm(command),
	findCommand: (command: string) => (boundary.isHelm(command) ? "helm" : null),
	findCommandAsync: async (command: string) =>
		boundary.isHelm(command) ? "helm" : null,
}));

vi.mock("../clients/lsp/capabilities.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../clients/lsp/capabilities.js")>();
	const { makeLspServiceDouble } =
		await import("./support/lsp-service-double.js");
	const double = makeLspServiceDouble({
		supportsLSP: () => boundary.lsp.enabled,
		hasLSP: async () => boundary.lsp.enabled,
		touchFile: boundary.lsp.touch,
	});
	return {
		...original,
		getLSPService: () =>
			boundary.lsp.enabled
				? (double as unknown as ReturnType<typeof original.getLSPService>)
				: original.getLSPService(),
	};
});

import extension from "../index.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { exportWidgetState } from "../clients/widget-state.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

let tmpDir = "";
const originalTestMode = process.env.PI_LENS_TEST_MODE;

beforeAll(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4484-witness-")),
	);
});
afterAll(() => removeTempDirSync(tmpDir));
beforeEach(() => {
	process.env.PI_LENS_TEST_MODE = "0";
	boundary.lsp.enabled = false;
	boundary.lsp.touches = 0;
	boundary.helm.stdout = "";
	boundary.helm.lintCalls = 0;
});
afterEach(() => {
	if (originalTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = originalTestMode;
});

type Tool = {
	execute: (...a: unknown[]) => Promise<{ content?: Array<{ text?: string }> }>;
};

const scrub = (s: string) =>
	s
		.replaceAll(tmpDir, "<PROJECT>")
		.replace(/·\s*\d+ms/g, "· <MS>ms")
		.trim();

/** One host session over one file, through the registered handlers. */
async function openSession(
	name: string,
	file: string,
	flags: Record<string, unknown> = {},
) {
	const pi = createPiMock({ "lens-guard": true, ...flags });
	extension(pi.asExtensionAPI());
	const ctx = () => makeCtx({ cwd: tmpDir });
	await pi.emit(
		"session_start",
		makeSessionStartEvent(),
		makeCtx({ cwd: tmpDir, sessionId: `pi-lens-4484-${name}` }),
	);
	await pi.emit("turn_start", {}, ctx());
	const target = path.join(tmpDir, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	let helmAfter: string | undefined;
	return {
		target,
		/** The next write's helm stdout (helm cells only). */
		helmNext(stdout: string) {
			helmAfter = stdout;
		},
		async write(content: string): Promise<string> {
			fs.writeFileSync(target, content);
			if (helmAfter !== undefined) boundary.helm.stdout = helmAfter;
			const r = (await pi.emit(
				"tool_result",
				{
					toolName: "write",
					input: { path: target, content },
					content: [{ type: "text", text: "wrote" }],
				},
				ctx(),
			)) as { content?: Array<{ text?: string }> } | undefined;
			return scrub((r?.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		async commitBlocked(): Promise<boolean> {
			const v = ((await pi.emit(
				"tool_call",
				{ toolName: "bash", input: { command: 'git commit -m "wip"' } },
				ctx(),
			)) ?? {}) as { block?: boolean };
			return v.block === true;
		},
		/** End the turn and return the context message it injects. */
		async endTurn(): Promise<string> {
			await pi.emit("turn_end", {}, ctx());
			const injected = (await pi.emit(
				"context",
				{ messages: [{ role: "user", content: "keep working" }] },
				ctx(),
			)) as { messages?: Array<{ content: string }> } | undefined;
			await pi.emit("turn_start", {}, ctx());
			return scrub(
				(injected?.messages ?? []).map((m) => m.content).join("\n\n"),
			);
		},
		async sessionDiagnostics(): Promise<string> {
			const lens = pi.tools.get("lens_diagnostics") as Tool;
			const out = await lens.execute(
				`zz-${name}`,
				{ source: "session", mode: "all" },
				undefined,
				null,
				{ cwd: tmpDir },
			);
			return scrub((out.content ?? []).map((p) => p.text ?? "").join("\n"));
		},
		widgetBlocking(): number {
			return exportWidgetState()
				.files.filter((f) => path.resolve(f.filePath) === target)
				.reduce((n, f) => n + (f.diagnosticCounts?.blocking ?? 0), 0);
		},
	};
}

const V1 = "const a = 1;\nBAD_CALL();\nconst b = 2;\n";
const V2_OTHER_LINE = "const a = 1;\nBAD_CALL();\nconst b = 3;\n";
const V2_INSERT_ABOVE =
	"const z = 0;\nconst a = 1;\nBAD_CALL();\nconst b = 2;\n";
const V_FIXED = "const a = 1;\nconst b = 2;\n";

const STILL_UNFIXED = /Still unfixed: 1 blocker reported earlier \(L(\d+)\)/;

/** Cleanup: fix the file and drain the turn, so the next cell starts clean. */
async function fixAndDrain(
	s: Awaited<ReturnType<typeof openSession>>,
	content: string,
) {
	await s.write(content);
	await s.endTurn();
	expect(await s.commitBlocked()).toBe(false);
}

describe("#4484 witness: a repeat write keeps an unfixed blocker pending", () => {
	it("keeps an LSP error that write 2 left in place blocking on every surface (cell A)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("a", "src/cell-a.ts");
		const w1 = await s.write(V1);
		expect(w1).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(await s.commitBlocked()).toBe(true);

		const latencyLog = getLatencyLogPath();
		await flushLatencyLog();
		const offset = fs.existsSync(latencyLog) ? fs.statSync(latencyLog).size : 0;
		const w2 = await s.write(V2_OTHER_LINE);
		// The write tells the agent the old blocker is still there, in one line,
		// and never says clean.
		expect(w2).not.toMatch(/clean/);
		expect(w2).not.toContain("🔴 STOP");
		expect(w2).toMatch(STILL_UNFIXED);
		expect(w2.match(STILL_UNFIXED)?.[1]).toBe("2");
		expect(await s.commitBlocked()).toBe(true);
		// The dispatch's own record says one blocker was held back by the delta.
		await flushLatencyLog();
		const rows = fs
			.readFileSync(latencyLog, "utf8")
			.slice(offset)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter(
				(row) =>
					row.result === "dispatch_complete" &&
					String(row.filePath).endsWith("cell-a.ts"),
			);
		expect(
			rows.map(
				(row) => (row.metadata as Record<string, unknown>).heldBackBlockers,
			),
		).toEqual([1]);

		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("Unresolved from this turn — src/cell-a.ts:");
		expect(turnEnd).toContain("L2: Cannot find name 'BAD_CALL'.");
		expect(turnEnd).not.toContain("Resolved this turn");
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.sessionDiagnostics()).toContain(
			"L2: Cannot find name 'BAD_CALL'.",
		);
		expect(s.widgetBlocking()).toBe(1);
		await fixAndDrain(s, V_FIXED);
	}, 120_000);

	it("still reports a write that removes the error as resolved and opens the gate (cell C)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("c", "src/cell-c.ts");
		await s.write(V1);
		expect(await s.commitBlocked()).toBe(true);
		const w2 = await s.write(V_FIXED);
		expect(w2).toContain("✓ JavaScript/TypeScript clean");
		expect(await s.commitBlocked()).toBe(false);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain(
			"Resolved this turn: src/cell-c.ts (1 blocker(s) cleared by the 2nd write)",
		);
		expect(turnEnd).not.toContain("Unresolved");
		expect(await s.sessionDiagnostics()).not.toContain("src/cell-c.ts");
		expect(s.widgetBlocking()).toBe(0);
	}, 120_000);

	it("re-blocks an LSP error moved by a line inserted above it as new (cell B, unchanged)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("b", "src/cell-b.ts");
		await s.write(V1);
		const w2 = await s.write(V2_INSERT_ABOVE);
		expect(w2).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(w2).toContain("L3: Cannot find name 'BAD_CALL'.");
		expect(w2).not.toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("L3: Cannot find name 'BAD_CALL'.");
		await fixAndDrain(s, V_FIXED);
	}, 120_000);

	it("keeps the error pending when write 2 comes in the next turn (cell I, cross-turn)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("i", "src/cell-i.ts");
		await s.write(V1);
		expect(await s.endTurn()).toContain("Unresolved from this turn");
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).not.toMatch(/clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("Unresolved from this turn — src/cell-i.ts:");
		expect(turnEnd).not.toMatch(/Resolved (this turn|since)/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s, V_FIXED);
	}, 120_000);

	it("re-delivers the error under --no-delta, before and after the fix (cell K)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("k", "src/cell-k.ts", { "no-delta": true });
		await s.write(V1);
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(w2).not.toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).toContain("Unresolved from this turn");
		await fixAndDrain(s, V_FIXED);
	}, 120_000);

	describe("a linter with ordinal ids (helm-lint)", () => {
		const chart = () => {
			fs.mkdirSync(path.join(tmpDir, "chart", "templates"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(tmpDir, "chart", "Chart.yaml"),
				"apiVersion: v2\nname: witness\nversion: 0.1.0\n",
			);
			fs.writeFileSync(
				path.join(tmpDir, "chart", "values.yaml"),
				"replicas: 2\n",
			);
		};
		const lint = (...lines: string[]) =>
			["==> Linting .", ...lines.map((l) => `[ERROR] templates/${l}`)].join(
				"\n",
			);
		const T1 =
			"apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: {{ .Values.replicas }}\n  paused: false\n";
		const T2 = T1.replace("paused: false", "paused: true");

		it("keeps a helm blocker that write 2 left in place, and after a line shift (cells F and H)", async () => {
			chart();
			const s = await openSession("f", "chart/templates/deploy-f.yaml", {
				"no-lsp": true,
			});
			const e4 = lint(
				"deploy-f.yaml:4: nil pointer evaluating interface {}.image",
			);
			s.helmNext(e4);
			expect(await s.write(T1)).toContain("🔴 STOP");
			s.helmNext(e4);
			const w2 = await s.write(T2);
			expect(w2).not.toMatch(/clean/);
			expect(w2.match(STILL_UNFIXED)?.[1]).toBe("4");
			expect(await s.commitBlocked()).toBe(true);
			// A line inserted above: the ordinal id stays, the line moves to 5.
			s.helmNext(
				lint("deploy-f.yaml:5: nil pointer evaluating interface {}.image"),
			);
			const w3 = await s.write(`# note\n${T2}`);
			expect(w3).not.toMatch(/clean/);
			expect(w3.match(STILL_UNFIXED)?.[1]).toBe("5");
			const turnEnd = await s.endTurn();
			expect(turnEnd).toContain(
				"Unresolved from this turn — chart/templates/deploy-f.yaml:",
			);
			expect(turnEnd).toContain("deploy-f.yaml:5: nil pointer");
			expect(turnEnd).not.toContain("Resolved this turn");
			expect(await s.commitBlocked()).toBe(true);
			expect(s.widgetBlocking()).toBe(1);
			s.helmNext("");
			await fixAndDrain(s, T2);
		}, 120_000);

		it("keeps the later helm blocker when fixing the earlier one renumbers it (cell R)", async () => {
			chart();
			const s = await openSession("r", "chart/templates/deploy-r.yaml", {
				"no-lsp": true,
			});
			s.helmNext(
				lint(
					"deploy-r.yaml:2: unknown field kind",
					"deploy-r.yaml:4: nil pointer evaluating interface {}.image",
				),
			);
			expect(await s.write(T1)).toContain(
				"🔴 STOP — 2 issue(s) must be fixed:",
			);
			// Fix the first: the second takes its ordinal id.
			s.helmNext(
				lint("deploy-r.yaml:4: nil pointer evaluating interface {}.image"),
			);
			const w2 = await s.write(T2);
			expect(w2).not.toMatch(/clean/);
			expect(w2.match(STILL_UNFIXED)?.[1]).toBe("4");
			expect(await s.commitBlocked()).toBe(true);
			const turnEnd = await s.endTurn();
			expect(turnEnd).toContain("deploy-r.yaml:4: nil pointer");
			expect(turnEnd).not.toContain("unknown field kind");
			expect(turnEnd).not.toContain("Resolved this turn");
			s.helmNext("");
			await fixAndDrain(s, T2);
		}, 120_000);
	});
});
