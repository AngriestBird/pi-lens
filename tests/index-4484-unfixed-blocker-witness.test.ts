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
		/** The fake language server: error 2304 on each `BAD_CALL` line, and
		 *  warning 6133 on each `unusedVar` line (round 2, row 16). */
		diagnose: (content: string): unknown[] =>
			content.split("\n").flatMap((line, i) => {
				const range = {
					start: { line: i, character: 0 },
					end: { line: i, character: 8 },
				};
				if (line.includes("BAD_CALL"))
					return [
						{
							severity: 1,
							message: "Cannot find name 'BAD_CALL'.",
							code: 2304,
							source: "ts",
							serverId: "typescript",
							range,
						},
					];
				if (line.includes("BAD_OTHER"))
					return [
						{
							severity: 1,
							message: "Cannot find name 'BAD_OTHER'.",
							code: 2304,
							source: "ts",
							serverId: "typescript",
							range,
						},
					];
				if (line.includes("unusedVar"))
					return [
						{
							severity: 2,
							message: "'unusedVar' is declared but its value is never read.",
							code: 6133,
							source: "ts",
							serverId: "typescript",
							range,
						},
					];
				return [];
			}),
		enabled: false,
		touches: 0,
		/**
		 * Round 2: how the server answers the next touch. `inconclusive` is a
		 * touch whose diagnostics wait hit its deadline, `partial` one where
		 * another server answered but typescript did not, `throw` a server
		 * that failed, `hold` an answer that arrives only when the test
		 * releases it.
		 */
		mode: "answer" as "answer" | "inconclusive" | "partial" | "throw" | "hold",
		/** Pending held answers; `release(true)` fails the touch instead. */
		held: [] as Array<(fail?: boolean) => void>,
		/**
		 * The double's touchFile. It lives here, not in the `vi.mock` factory:
		 * `tests/config/vi-mock-export-sweep.test.ts` reads a factory's export
		 * list off the first `return` it finds (the #3190 witness's note).
		 */
		touch: async (
			_file: string,
			content: string,
			options?: { source?: string },
		) => {
			lsp.touches += 1;
			if (lsp.mode === "inconclusive")
				return {
					diags: [],
					inconclusive: true,
					inconclusiveServerIds: ["typescript"],
				};
			if (lsp.mode === "partial")
				return {
					diags: [
						{
							severity: 2,
							message: "Prefer a const declaration.",
							code: "use-const",
							source: "biome",
							serverId: "biome",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 5 },
							},
						},
					],
					inconclusive: true,
					inconclusiveServerIds: ["typescript"],
				};
			if (lsp.mode === "throw")
				throw new Error("connection closed: the JSON RPC server exited");
			// Only the dispatch runner's check is held: the turn end's own
			// re-verify touch of a recorded blocker answers, so it never waits
			// out its hook budget on an answer the test has not released.
			if (lsp.mode === "hold" && options?.source === "dispatch-lsp-runner")
				return new Promise((resolve, reject) => {
					lsp.held.push((fail) =>
						fail
							? reject(
									new Error("connection closed: the JSON RPC server exited"),
								)
							: resolve({ diags: lsp.diagnose(content) }),
					);
				});
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
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../clients/dispatch/collect-later-tier.js";
import {
	peekSettledRunnerFindings,
	resetPendingRunnerFindings,
	settlePendingRunnerFindingsForTests,
} from "../clients/dispatch/pending-runner-findings.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { getDegradationSummary } from "../clients/degradation-ledger.js";
import { exportWidgetState } from "../clients/widget-state.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

let tmpDir = "";
let pendingCleanup: (() => Promise<void>) | undefined;
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
	boundary.lsp.mode = "answer";
	boundary.helm.stdout = "";
	boundary.helm.lintCalls = 0;
});
afterEach(async () => {
	// A cell that failed before its own fix still leaves no record, gate
	// state or persisted guard record for the next cell (shuffle-safe).
	const cleanup = pendingCleanup;
	pendingCleanup = undefined;
	boundary.lsp.mode = "answer";
	for (const release of boundary.lsp.held.splice(0)) release();
	resetObservedRunnerLatency();
	if (cleanup) await cleanup().catch(() => {});
	resetPendingRunnerFindings();
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
	fixed: string,
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
	const session = {
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
		/** Round 4 (P18): a host `write` of another file in the same session. */
		async writeOther(file: string, content: string): Promise<void> {
			const other = path.join(tmpDir, file);
			fs.mkdirSync(path.dirname(other), { recursive: true });
			fs.writeFileSync(other, content);
			await pi.emit(
				"tool_result",
				{
					toolName: "write",
					input: { path: other, content },
					content: [{ type: "text", text: "wrote" }],
				},
				ctx(),
			);
		},
		/** A host `edit` that changed `lines` (1-based), as its diff names them. */
		async edit(content: string, lines: number[]): Promise<string> {
			fs.writeFileSync(target, content);
			const after = content.split("\n");
			const r = (await pi.emit(
				"tool_result",
				{
					toolName: "edit",
					input: { path: target },
					details: {
						diff: lines.map((n) => `+ ${n} ${after[n - 1] ?? ""}`).join("\n"),
					},
					content: [{ type: "text", text: "edited" }],
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
	pendingCleanup = async () => {
		helmAfter = "";
		await session.write(fixed);
		await session.endTurn();
	};
	return session;
}

const V1 = "const a = 1;\nBAD_CALL();\nconst b = 2;\n";
const V2_OTHER_LINE = "const a = 1;\nBAD_CALL();\nconst b = 3;\n";
const V2_INSERT_ABOVE =
	"const z = 0;\nconst a = 1;\nBAD_CALL();\nconst b = 2;\n";
const V_FIXED = "const a = 1;\nconst b = 2;\n";
const V_FIXED_OTHER = "const a = 1;\nconst b = 4;\n";

const STILL_UNFIXED = /Still unfixed: 1 blocker reported earlier \(L(\d+)\)/;

/** Cleanup: fix the file and drain the turn, so the next cell starts clean. */
async function fixAndDrain(s: Awaited<ReturnType<typeof openSession>>) {
	const cleanup = pendingCleanup;
	pendingCleanup = undefined;
	await cleanup?.();
	expect(await s.commitBlocked()).toBe(false);
}

describe("#4484 witness: a repeat write keeps an unfixed blocker pending", () => {
	it("keeps an LSP error that write 2 left in place blocking on every surface (cell A)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("a", "src/cell-a.ts", V_FIXED);
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
		// The offset is a byte count, so slice the bytes before decoding: a
		// multi-byte character earlier in the log (an emoji in a message) moves
		// a character index off the row boundary (review F3, seed 202).
		const rows = fs
			.readFileSync(latencyLog)
			.subarray(offset)
			.toString("utf8")
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
		await fixAndDrain(s);
	}, 120_000);

	it("still reports a write that removes the error as resolved and opens the gate (cell C)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("c", "src/cell-c.ts", V_FIXED);
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
		const s = await openSession("b", "src/cell-b.ts", V_FIXED);
		await s.write(V1);
		const w2 = await s.write(V2_INSERT_ABOVE);
		expect(w2).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(w2).toContain("L3: Cannot find name 'BAD_CALL'.");
		expect(w2).not.toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("L3: Cannot find name 'BAD_CALL'.");
		await fixAndDrain(s);
	}, 120_000);

	it("keeps the error pending when write 2 comes in the next turn (cell I, cross-turn)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("i", "src/cell-i.ts", V_FIXED);
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
		await fixAndDrain(s);
	}, 120_000);

	it("re-delivers the error under --no-delta, before and after the fix (cell K)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("k", "src/cell-k.ts", V_FIXED, {
			"no-delta": true,
		});
		await s.write(V1);
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(w2).not.toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).toContain("Unresolved from this turn");
		await fixAndDrain(s);
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
			const s = await openSession("f", "chart/templates/deploy-f.yaml", T2, {
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
			await fixAndDrain(s);
		}, 120_000);

		it("keeps the later helm blocker when fixing the earlier one renumbers it (cell R)", async () => {
			chart();
			const s = await openSession("r", "chart/templates/deploy-r.yaml", T2, {
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
			await fixAndDrain(s);
		}, 120_000);
	});
});

/**
 * Round 2 (#4484): a recorded blocker leaves the record only when a
 * conclusive observation from its own source shows it gone. Rows refer to
 * the state table at the top of PR #4491.
 */
describe("#4484 witness, round 2: only evidence retires a recorded blocker", () => {
	/** `no-unknown-returns` (ast-grep, severity error) on line 3 (#4482's shape). */
	const AST_GREP_SRC = [
		'export const CLIENT_VERSION = "1.0.50";',
		"export const plain = CLIENT_VERSION;",
		"export function dig(obj: Record<string, string>, key: string): unknown {",
		"\treturn obj[key];",
		"}",
		"",
	].join("\n");
	const AST_GREP_EDITED = AST_GREP_SRC.replace("1.0.50", "1.0.51");
	const AST_GREP_FIXED = AST_GREP_SRC.replace("): unknown {", "): string {");
	/** `debugger-statement` (tree-sitter, severity error) on line 2. */
	const TS_SRC =
		"export function run(): void {\n\tdebugger;\n}\nexport const a = 1;\n";
	const TS_EDITED = TS_SRC.replace("a = 1", "a = 2");
	const TS_FIXED = "export function run(): void {}\nexport const a = 1;\n";
	const SCOPED = { "no-lsp": true, "no-ast-grep": true };

	// Recurrence: since #4482 the ast-grep runner drops a blocker on a line the
	// edit did not change, so an edit elsewhere emptied the observation and the
	// record cleared (TLC MutRangeGated).
	it("keeps an ast-grep blocker pending after an edit to another line (row 7)", async () => {
		const s = await openSession(
			"sa",
			"src/scope-ag.ts",
			AST_GREP_FIXED,
			SCOPED,
		);
		const w1 = await s.write(AST_GREP_SRC);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("no-unknown-returns");
		expect(await s.commitBlocked()).toBe(true);
		const w2 = await s.edit(AST_GREP_EDITED, [1]);
		expect(w2).not.toMatch(/clean/);
		expect(w2).not.toContain("🔴 STOP");
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L3\)/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("Unresolved from this turn — src/scope-ag.ts:");
		expect(turnEnd).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence: tree-sitter's edit-range gate did the same before #4482.
	it("keeps a tree-sitter blocker pending after an edit to another line (row 7)", async () => {
		const s = await openSession("st", "src/scope-ts.ts", TS_FIXED, SCOPED);
		const w1 = await s.write(TS_SRC);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("debugger");
		const w2 = await s.edit(TS_EDITED, [4]);
		expect(w2).not.toMatch(/clean/);
		expect(w2).not.toContain("🔴 STOP");
		expect(w2).toMatch(/Still unfixed: \d+ blockers? reported earlier \(L2\)/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("Unresolved from this turn — src/scope-ts.ts:");
		await fixAndDrain(s);
	}, 120_000);

	// Control (#4481 kept): a pre-existing finding on a line the agent never
	// touched is observed, not delivered, and never enters the record.
	it("does not block on a pre-existing ast-grep finding outside the first edit (row 8)", async () => {
		const file = "src/scope-pre.ts";
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, file), AST_GREP_SRC);
		const s = await openSession("sp", file, AST_GREP_EDITED, SCOPED);
		const w1 = await s.edit(AST_GREP_EDITED, [1]);
		expect(w1).not.toContain("🔴 STOP");
		expect(w1).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).not.toContain("Unresolved from this turn");
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence: a run with no verdict read as an empty, clean observation
	// (TLC MutFailClear).
	it("keeps an LSP error pending when the server does not answer the next write (row 10)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("xt", "src/carry-timeout.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		// The carry of an unobserved blocker is counted once per file.
		expect(
			getDegradationSummary().find(
				(c) => c.kind === "blocker-carried-unobserved",
			)?.latestReasons,
		).toContainEqual(
			expect.objectContaining({
				subject: expect.stringContaining("carry-timeout.ts"),
			}),
		);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain(
			"Unresolved from this turn — src/carry-timeout.ts:",
		);
		expect(turnEnd).not.toContain("Resolved this turn");
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	it("keeps an LSP error pending when the server fails on the next write (row 10)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("xf", "src/carry-fail.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "throw";
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence: a run that answered for one server read as a verdict for
	// every server, so the silent server's recorded error left the record.
	it("keeps an LSP error pending when its own server is unconfirmed while another answers (row 10)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("xp", "src/carry-partial.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "partial";
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence: TLC MutDeferredInFlight. A write cleared the record while the
	// blocker's own re-check ran collect-later, and turn end called it resolved.
	it("keeps a blocker pending while its collect-later re-check runs, and retires it only when a current run settles clean (rows 12, 14)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("dl", "src/carry-deferred.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		// The language server is now slow: its next runs leave the write path.
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "lsp",
			durationMs: 6_000,
		});
		boundary.lsp.mode = "hold";
		const w2 = await s.write(V2_OTHER_LINE);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain(
			"Unresolved from this turn — src/carry-deferred.ts:",
		);
		expect(turnEnd).not.toContain("Resolved this turn");
		// The fix lands while the server is still slow: nothing has seen it yet.
		await s.write(V_FIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		// Both held runs answer; only the one about the current bytes counts.
		for (const release of boundary.lsp.held.splice(0)) release();
		await settlePendingRunnerFindingsForTests();
		expect(peekSettledRunnerFindings().length).toBeGreaterThanOrEqual(2);
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).toMatch(
			/Resolved this turn: src\/carry-deferred\.ts/,
		);
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence: a settled re-check that failed is no evidence, yet an empty
	// failed answer would read as "E gone"; and with no commit before turn end,
	// only the turn end's late lane can retire the blocker.
	it("retires nothing on a failed collect-later re-check, and retires at turn end on a clean one (rows 10, 14)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("df", "src/carry-deferred-fail.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "lsp",
			durationMs: 6_000,
		});
		boundary.lsp.mode = "hold";
		await s.write(V_FIXED);
		for (const release of boundary.lsp.held.splice(0)) release(true);
		await settlePendingRunnerFindingsForTests();
		expect(peekSettledRunnerFindings().length).toBeGreaterThanOrEqual(1);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		// A clean re-check of the current bytes settles; no commit asks first.
		// The quick failure moved the server back inline, so slow it again.
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "lsp",
			durationMs: 6_000,
		});
		await s.write(V_FIXED_OTHER);
		for (const release of boundary.lsp.held.splice(0)) release();
		await settlePendingRunnerFindingsForTests();
		expect(peekSettledRunnerFindings().length).toBeGreaterThanOrEqual(1);
		expect(await s.endTurn()).toMatch(
			/Resolved this turn: src\/carry-deferred-fail\.ts/,
		);
		expect(await s.commitBlocked()).toBe(false);
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence: an unused value blocks only while the delta calls it new, so
	// the next unrelated write dropped it from the record as if fixed (TLC
	// MutPromotedClear).
	it("keeps a delta-promoted unused value blocking on the next unrelated write (row 16)", async () => {
		boundary.lsp.enabled = true;
		const U1 = "const a = 1;\nconst unusedVar = 2;\nconst b = 2;\n";
		const U2 = "const a = 1;\nconst unusedVar = 2;\nconst b = 3;\n";
		const s = await openSession("un", "src/carry-unused.ts", V_FIXED);
		// The delta promotes only against a baseline, so the file exists first.
		await s.write(V_FIXED);
		const w1 = await s.write(U1);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("unusedVar");
		const w2 = await s.write(U2);
		expect(w2).not.toMatch(/clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 120_000);
});

/**
 * Round 3 (#4484): rows refer to the round-3 state table at the top of PR
 * #4491. R1: a run has a verdict only when it read the file and finished.
 * R2: a recorded blocker's position is its line aligned to the current bytes.
 * R3: it stays only while its source has no verdict, or a verdict saw its
 * identity at its position. R4: lines a no-verdict run owed join the next
 * run's range.
 */
describe("#4484 witness, round 3: position, verdict and owed lines", () => {
	const SCOPED = { "no-lsp": true, "no-ast-grep": true };
	const AG_PRE = [
		'export const CLIENT_VERSION = "1.0.50";',
		"export const plain = CLIENT_VERSION;",
		"export function dig(obj: Record<string, string>, key: string): unknown {",
		"\treturn obj[key];",
		"}",
		"",
	].join("\n");
	const AG_TWIN = `${AG_PRE}export function dig2(obj: Record<string, string>, key: string): unknown {\n\treturn obj[key];\n}\n`;
	const AG_TWIN_FIXED = AG_TWIN.replace(
		"dig2(obj: Record<string, string>, key: string): unknown",
		"dig2(obj: Record<string, string>, key: string): string",
	);
	const TS_PRE =
		"export function run(): void {\n\tdebugger;\n}\nexport const a = 1;\n";
	const TS_TWIN = `${TS_PRE}export function run2(): void {\n\tdebugger;\n}\n`;
	const TS_TWIN_FIXED = `${TS_PRE}export function run2(): void {\n\treturn;\n}\n`;

	// Recurrence (F1, review probe P9): the carry matched on identity alone, so
	// a pre-existing, never-delivered match of the same rule outside the edit
	// stood in for the blocker the edit fixed. The gate stayed shut on L3, a
	// line the agent never touched (TLC MutTwinIdentity).
	it("retires a fixed ast-grep blocker beside an untouched match of the same rule (row 6)", async () => {
		const file = "src/twin-ag.ts";
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, file), AG_PRE);
		const s = await openSession("ta", file, AG_PRE, SCOPED);
		const w1 = await s.edit(AG_TWIN, [6, 7, 8]);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("L6:");
		expect(await s.commitBlocked()).toBe(true);
		const w2 = await s.edit(AG_TWIN_FIXED, [6]);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(w2).not.toContain("🔴 STOP");
		expect(await s.commitBlocked()).toBe(false);
		const turnEnd = await s.endTurn();
		expect(turnEnd).not.toContain("Unresolved from this turn");
		expect(turnEnd).toMatch(/Resolved this turn: src\/twin-ag\.ts/);
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence (F1, review probe P10): the same stand-in through tree-sitter.
	it("retires a fixed tree-sitter blocker beside an untouched match of the same rule (row 6)", async () => {
		const file = "src/twin-ts.ts";
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, file), TS_PRE);
		const s = await openSession("tt", file, TS_PRE, SCOPED);
		const w1 = await s.edit(TS_TWIN, [5, 6, 7]);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("L6:");
		const w2 = await s.edit(TS_TWIN_FIXED, [6]);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(w2).not.toContain("🔴 STOP");
		expect(await s.commitBlocked()).toBe(false);
		const turnEnd = await s.endTurn();
		expect(turnEnd).not.toContain("Unresolved from this turn");
		pendingCleanup = undefined;
	}, 120_000);

	// Control (row 7): the recorded blocker's own line, moved by an edit above
	// it, still holds the match; the other occurrence never enters the record.
	it("keeps a recorded ast-grep blocker at its own moved line, and only that one (row 7)", async () => {
		const file = "src/twin-move.ts";
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, file), AG_PRE);
		const s = await openSession("tm", file, AG_PRE, SCOPED);
		expect(await s.edit(AG_TWIN, [6, 7, 8])).toContain("🔴 STOP");
		const moved = `// header\n${AG_TWIN}`;
		const w2 = await s.edit(moved, [1]);
		expect(w2).not.toContain("🔴 STOP");
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L7\)/);
		expect(await s.commitBlocked()).toBe(true);
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("L7:");
		expect(turnEnd).not.toContain("L4:");
		pendingCleanup = async () => {
			await s.write(moved.replaceAll("): unknown {", "): string {"));
			await s.endTurn();
		};
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (row 12, R3): a blocker carried while its server had no verdict
	// kept its recorded line after an edit above it, so the write and turn end
	// named a line the error was no longer on.
	it("moves a carried LSP error with its line while the server does not answer (row 12)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("cm", "src/carry-move.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		boundary.lsp.mode = "inconclusive";
		const w2 = await s.write(V2_INSERT_ABOVE);
		expect(w2.match(STILL_UNFIXED)?.[1]).toBe("3");
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("L3:");
		expect(turnEnd).not.toContain("L2:");
		boundary.lsp.mode = "answer";
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (F2, review probe P1): a skip that never read the file counted
	// as a verdict. Past the LSP sync limit the runner skips without touching
	// the server, and the record retired while BAD_CALL was on disk (TLC
	// MutSkipVerdict).
	it("keeps an LSP error pending when the file outgrows the language server's sync limit (row 11)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("sl", "src/skip-lsp.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		const touches = boundary.lsp.touches;
		const big = `${V1}${"const pad = 0;\n".repeat(5_100)}`;
		const w2 = await s.write(big);
		expect(boundary.lsp.touches).toBe(touches);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(STILL_UNFIXED);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (F2, review probe P2): the ast-grep runner skips a file over
	// 1 MiB without reading it, and the edit said clean.
	it("keeps an ast-grep blocker pending when the file outgrows the runner's size cap (row 11)", async () => {
		const s = await openSession("sg", "src/skip-ag.ts", AG_PRE, SCOPED);
		const AG_FIXED = AG_PRE.replace("): unknown {", "): string {");
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		const big = `${AG_PRE}// ${"x".repeat(1_100_000)}\n`;
		const w2 = await s.edit(big, [6]);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L3\)/);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		pendingCleanup = async () => {
			await s.write(AG_FIXED);
			await s.endTurn();
		};
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (residual a): a blocker first seen while its runner had no
	// verdict was never recorded, because the next run withheld it as out of
	// range (TLC MutOwedRanges).
	it("records a blocker first written while its runner had no verdict once the runner next answers (row 15)", async () => {
		const AG_FIXED = AG_PRE.replace("): unknown {", "): string {");
		const s = await openSession("ow", "src/owed-ag.ts", AG_FIXED, SCOPED);
		await s.write(AG_FIXED);
		// One edit adds the blocker at L3 and grows the file past the cap, so
		// the ast-grep run skips without reading it.
		const big = `${AG_PRE}// ${"x".repeat(1_100_000)}\n`;
		const w1 = await s.edit(big, [3, 6]);
		expect(w1).not.toContain("no-unknown-returns");
		// The next edit only removes the padding; L3 is outside its range.
		const w2 = await s.edit(AG_PRE, [6]);
		expect(w2).toContain("🔴 STOP");
		expect(w2).toContain("L3:");
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (F4, review probe P5): a new error that took a fixed error's
	// line-bound id was held back by the delta and labelled "still unfixed …
	// earlier", although the agent had never seen it.
	it("delivers a new error that takes a fixed error's id in the STOP block (row 16)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("lb", "src/label-new.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		const w2 = await s.write(V1.replace("BAD_CALL", "BAD_OTHER"));
		expect(w2).toContain("🔴 STOP");
		expect(w2).toContain("L2: Cannot find name 'BAD_OTHER'.");
		expect(w2).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);
});

describe("#4484 witness, round 4: no alignment fails closed", () => {
	const SCOPED = { "no-lsp": true, "no-ast-grep": true };
	const AG_PRE = [
		'export const CLIENT_VERSION = "1.0.50";',
		"export const plain = CLIENT_VERSION;",
		"export function dig(obj: Record<string, string>, key: string): unknown {",
		"\treturn obj[key];",
		"}",
		"",
	].join("\n");
	const AG_FIXED = AG_PRE.replace("): unknown {", "): string {");
	const TS_PRE =
		"export function run(): void {\n\tdebugger;\n}\nexport const a = 1;\n";
	const TS_FIXED = TS_PRE.replace("\tdebugger;\n", "\treturn;\n");
	// 1100 distinct lines above and a new last line: no common prefix, and a
	// middle past the 1000-edit cap, so the write has no alignment.
	const PAD = Array.from({ length: 1100 }, (_, i) => `// pad ${i}`).join("\n");
	const padRange = Array.from({ length: 1100 }, (_, i) => i + 1);

	// Recurrence (G1, verify probe P11c): with no alignment the carry read the
	// recorded line number as it was, found nothing there, and retired an
	// ast-grep blocker still on disk: `✓ clean`, the gate open, and "Resolved"
	// at turn end (TLC MutUnaligned).
	it("keeps an ast-grep blocker pending when the write cannot be aligned (row 4, P11c)", async () => {
		const s = await openSession("uc", "src/unaligned-ag.ts", AG_FIXED, SCOPED);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		const big = `${PAD}\n${AG_PRE}export const tail = 1;\n`;
		const w2 = await s.edit(big, [...padRange, 1106]);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L1103\)/);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (G1, verify probe P11d): the same through tree-sitter.
	it("keeps a tree-sitter blocker pending when the write cannot be aligned (row 4, P11d)", async () => {
		const s = await openSession("ud", "src/unaligned-ts.ts", TS_FIXED, SCOPED);
		await s.write(TS_FIXED);
		expect(await s.edit(TS_PRE, [2])).toContain("🔴 STOP");
		const big = `${PAD}\n${TS_PRE}export const tail = 1;\n`;
		const w2 = await s.edit(big, [...padRange, 1105]);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L1102\)/);
		expect(await s.commitBlocked()).toBe(true);
		expect(await s.endTurn()).not.toContain("Resolved this turn");
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (G1 and G3, verify probe P18): the anchor lived in a
	// 256-entry cache apart from the record. Writes to 260 other files evicted
	// it, and the next edit above the blocker retired it with nothing to align.
	it("keeps a tree-sitter blocker's anchor across writes to 260 other files (row 10, P18)", async () => {
		const s = await openSession("evict", "src/evicted-ts.ts", TS_FIXED, SCOPED);
		await s.write(TS_FIXED);
		expect(await s.edit(TS_PRE, [2])).toContain("🔴 STOP");
		for (let i = 0; i < 260; i += 1)
			await s.writeOther(
				`src/p18/other-${i}.ts`,
				`export const v${i} = ${i};\n`,
			);
		const w2 = await s.edit(`// header\n${TS_PRE}`, [1]);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L3\)/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);

	// G1's third path (round-4 brief item 4): past the blocker baseline's
	// 2 MiB cap the write's bytes get no line hashes, so it has no alignment.
	it("keeps a tree-sitter blocker pending when the file outgrows the 2 MiB hash cap (row 4)", async () => {
		const s = await openSession("ug", "src/hashcap-ts.ts", TS_FIXED, SCOPED);
		await s.write(TS_FIXED);
		expect(await s.edit(TS_PRE, [2])).toContain("🔴 STOP");
		const wide = Array.from(
			{ length: 2100 },
			(_, i) => `// ${String(i).padStart(4, "0")} ${"x".repeat(1000)}`,
		).join("\n");
		const w2 = await s.edit(
			`${wide}\n${TS_PRE}`,
			Array.from({ length: 2100 }, (_, i) => i + 1),
		);
		expect(w2).not.toMatch(/✓ .*clean/);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (G2, verify probe P20): the agent deletes the line its own
	// blocker was on, and an untouched match of the same rule slides onto that
	// number. A deleted line has no position, so nothing stands in for it
	// (mutation X17 read the stale number and kept a false "Still unfixed").
	it("retires a deleted blocker although an untouched match slides onto its line number (row 3, P20)", async () => {
		const OLD = "export function old(): void {\n\tdebugger; // old\n}\n";
		const NEU = "export function neu(): void {\n\tdebugger;\n}\n";
		const FIXED = OLD.replace("\tdebugger; // old\n", "\treturn;\n");
		// The untouched match is on disk before the session, so no write
		// delivers or records it (#4481).
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src/slide-ts.ts"), OLD);
		const s = await openSession("uf", "src/slide-ts.ts", FIXED, SCOPED);
		const w1 = await s.edit(`${NEU}${OLD}`, [1, 2, 3]);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("L2:");
		expect(w1).not.toContain("L5:");
		const w2 = await s.edit(OLD, [1]);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(false);
		pendingCleanup = undefined;
	}, 120_000);
});

describe("#4484 witness, round 5: a fallback holds only what its evidence names", () => {
	const SCOPED = { "no-lsp": true, "no-ast-grep": true };
	const AG_PRE = [
		'export const CLIENT_VERSION = "1.0.50";',
		"export const plain = CLIENT_VERSION;",
		"export function dig(obj: Record<string, string>, key: string): unknown {",
		"\treturn obj[key];",
		"}",
		"",
	].join("\n");
	const AG_FIXED = AG_PRE.replace("): unknown {", "): string {");
	const PAD = Array.from({ length: 1100 }, (_, i) => `// pad ${i}`).join("\n");
	const padRange = Array.from({ length: 1100 }, (_, i) => i + 1);
	// Past the ast-grep runner's 1 MiB cap: it skips without reading the file.
	const OVER_CAP = `// ${"x".repeat(1_100_000)}`;

	// Recurrence (K1, verify probe P22): with no alignment the carry matched
	// the agent's fixed `debugger` by identity alone, so an untouched,
	// never-delivered `debugger` with other text took over the record and
	// blocked through every later write and turn end (TLC MutUnalignedText).
	it("retires a fixed blocker on an unaligned write although an older match with other text stays (row 4b, P22)", async () => {
		const OLD = "export function old(): void {\n\tdebugger; // old\n}\n";
		const NEU = "export function neu(): void {\n\tdebugger;\n}\n";
		const FIXED = OLD.replace("\tdebugger; // old\n", "\treturn;\n");
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src/adopt-ts.ts"), OLD);
		const s = await openSession("adopt", "src/adopt-ts.ts", FIXED, SCOPED);
		const w1 = await s.edit(`${NEU}${OLD}`, [1, 2, 3]);
		expect(w1).toContain("🔴 STOP");
		expect(w1).toContain("L2:");
		// No common prefix and a middle past the edit cap: no alignment.
		const w2 = await s.edit(`${PAD}\n${OLD}export const tail = 1;\n`, [
			...padRange,
			1104,
		]);
		expect(w2).not.toMatch(/Still unfixed/);
		expect(await s.commitBlocked()).toBe(false);
		expect(await s.endTurn()).not.toContain("STOP");
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence (K1's stale line): a write with no alignment kept a blocker
	// its runner gave no verdict on at its old line number. The next write
	// aligned that stale number to another line, found nothing there, and
	// retired the blocker while it was still on disk.
	it("keeps a blocker its runner skipped on an unaligned write once the next write aligns (row 6b)", async () => {
		const s = await openSession("stale", "src/stale-ag.ts", AG_FIXED, SCOPED);
		await s.write(AG_FIXED);
		expect(await s.edit(AG_PRE, [3])).toContain("🔴 STOP");
		// Unaligned, and past the runner's size cap: no verdict, no position.
		const w2 = await s.edit(`${PAD}\n${AG_PRE}${OVER_CAP}\n`, [
			...padRange,
			1106,
		]);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier/);
		// Dropping the padding line aligns, and the runner reads the file again.
		const w3 = await s.edit(`${PAD}\n${AG_PRE}`, [1106]);
		expect(w3).not.toMatch(/✓ .*clean/);
		expect(w3).toMatch(/Still unfixed: 1 blocker reported earlier \(L1103\)/);
		expect(await s.commitBlocked()).toBe(true);
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (K2, verify probe P23): a file with no blocker record kept
	// only the id of a runner that skipped it, so the next write owed that
	// runner the whole file, and an untouched, pre-existing finding became a
	// new STOP (TLC MutOwedByContent).
	it("owes a runner that skipped a file with no record only the lines it skipped (row 9, P23)", async () => {
		const BASE = `${AG_PRE}export const k = 1;\n`;
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src/owed-pre.ts"), BASE);
		const s = await openSession("owpre", "src/owed-pre.ts", AG_FIXED, SCOPED);
		const W0 = BASE.replace("k = 1", "k = 2");
		expect(await s.edit(W0, [6])).toMatch(/✓ .*clean/);
		// The skipped lines hold a copy of the pre-existing finding's own line,
		// so owed positions must be remapped, not matched by text.
		const COPY = AG_PRE.split("\n").slice(2, 5).join("\n");
		const w1 = await s.edit(`${W0}${COPY}\n${OVER_CAP}\n`, [7, 8, 9, 10]);
		expect(w1).toMatch(/✓ .*clean/);
		const w2 = await s.edit(W0, [6]);
		expect(w2).not.toContain("STOP");
		expect(w2).toMatch(/✓ .*clean/);
		expect(await s.commitBlocked()).toBe(false);
		pendingCleanup = undefined;
	}, 120_000);

	// Recurrence (K2's sibling, row 12): an unaligned write to a file with a
	// record owed a runner that had skipped the whole file, so a pre-existing,
	// never-delivered finding became a new STOP. Owed lines follow their text.
	it("owes a runner that skipped only its skipped lines on an unaligned write to a recorded file (row 12)", async () => {
		const TS_BAD = "debugger; // top\n";
		const TS_OK = "// top\n";
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src/owed-rec.ts"), AG_PRE);
		const s = await openSession("owrec", "src/owed-rec.ts", AG_PRE, SCOPED);
		// The debugger blocks (tree-sitter, recorded); the ast-grep runner skips
		// the file past its size cap and owes the edit's lines.
		const w1 = await s.edit(`${TS_BAD}${AG_PRE}${OVER_CAP}\n`, [1, 7]);
		expect(w1).toContain("🔴 STOP");
		expect(w1).not.toContain("no-unknown-returns");
		// Unaligned, and back under the cap: the owed lines moved by 1100.
		const w2 = await s.edit(`${PAD}\n${TS_BAD}${AG_PRE}`, padRange);
		expect(w2).toMatch(/Still unfixed: 1 blocker reported earlier \(L1101\)/);
		expect(w2).not.toContain("unknown");
		pendingCleanup = async () => {
			await s.write(`${TS_OK}${AG_FIXED}`);
			await s.endTurn();
		};
		await fixAndDrain(s);
	}, 120_000);

	// Recurrence (K3, verify probe P25): a carry moved a blocker's line but
	// kept its line-bound id, so the settled re-check's copy at the same line
	// joined the record beside it, and the turn end listed it twice.
	it("lists a carried blocker once after its collect-later re-check settles (row 13, P25)", async () => {
		boundary.lsp.enabled = true;
		const s = await openSession("dup", "src/carry-dup.ts", V_FIXED);
		expect(await s.write(V1)).toContain("🔴 STOP");
		observeRunnerLatency({
			projectRoot: tmpDir,
			runnerId: "lsp",
			durationMs: 6_000,
		});
		boundary.lsp.mode = "hold";
		const w2 = await s.write(`BAD_OTHER();\nconst z = 0;\n${V1}`);
		expect(w2.match(STILL_UNFIXED)?.[1]).toBe("4");
		for (const release of boundary.lsp.held.splice(0)) release();
		await settlePendingRunnerFindingsForTests();
		const turnEnd = await s.endTurn();
		expect(turnEnd).toContain("STOP — 2 issue(s)");
		expect(turnEnd.match(/L4:/g)?.length).toBe(1);
		expect(turnEnd).toContain("L1:");
		boundary.lsp.mode = "answer";
		await s.write(V_FIXED);
		await settlePendingRunnerFindingsForTests();
		await s.endTurn();
		pendingCleanup = undefined;
	}, 120_000);
});
