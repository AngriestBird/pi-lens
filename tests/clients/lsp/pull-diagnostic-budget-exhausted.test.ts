/**
 * #1773: a budget-exhausted pull previously dispatched anyway. The old clamp
 * (`Math.max(1, Math.min(PULL_REQUEST_TIMEOUT_MS, budgetMs))`) let
 * `budgetMs <= 0` through as an unwinnable 1ms pull — sent, timed out by
 * construction, and recorded as a genuine `lsp_pull_diagnostic_timeout` with
 * a fabricated `effectiveBudgetMs: 1`. Fix: at or below a 5ms usable floor
 * (`PULL_MIN_USABLE_BUDGET_MS`), skip the dispatch entirely and emit a
 * distinct `lsp_pull_skipped_budget_exhausted` record instead. TWO entry
 * points had this clamp independently — `pullDiagnosticSource` (the
 * `lens_diagnostics_full` fan-out) and `clientRequestWorkspaceDiagnostics`
 * (the `workspace/diagnostic` round) — both fixed and both covered below,
 * per live dogfood evidence naming both as sources of the artifact.
 *
 * #1774: a pull timeout arms a telemetry-only continuation on the abandoned
 * request (`armLateAnswerTelemetry`). It already saw late RESOLUTIONS
 * (`lsp_pull_late_answer_discarded`), but the rejection branch was silent, so
 * "timeout then silence" and "timeout then server rejection" read identically
 * in latency.log. Fix: the rejection path now emits a bounded
 * `lsp_pull_late_rejection` record (error code, server, elapsed-since-
 * timeout) while still swallowing the rejection — behavior on that path is
 * otherwise unchanged.
 *
 * #1771: `lsp_pull_diagnostic_timeout` (a genuine, dispatched-then-abandoned
 * pull) was emitted with no `ledgerKind`, so it counted nothing in the
 * degradation ledger even though it is a failure path by the
 * bounded-telemetry module's own rule. Fix: `recordPullTimeoutTelemetry` now
 * passes `ledgerKind: "lsp-pull-diagnostic-timeout"`, subject preserving
 * server + file identity.
 *
 * Connection-double tests: `state.connection.sendRequest` is a mock, not a
 * wire-protocol server (matches `pull-diagnostic-timeout-telemetry.test.ts`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { latencyEvents } = vi.hoisted(() => ({
	latencyEvents: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: vi.fn((event: Record<string, unknown>) => {
			latencyEvents.push(event);
		}),
	};
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	clientRequestWorkspaceDiagnostics,
	clientWaitForDiagnostics,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pullState(overrides?: Partial<LSPClientState>): LSPClientState {
	return createMockState({
		serverId: "typescript",
		root: "/project",
		workspaceDiagnosticsSupport: {
			advertised: true,
			mode: "pull",
			workspaceDiagnostics: false,
			diagnosticProviderKind: "static",
		},
		staticDiagnosticsMode: "push-only",
		...overrides,
	});
}

function installSendRequest(
	state: LSPClientState,
	handler: (method: string, params: unknown) => Promise<unknown>,
) {
	const mock = vi.fn(handler);
	state.connection.sendRequest =
		mock as unknown as typeof state.connection.sendRequest;
	return mock;
}

const skipEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_pull_skipped_budget_exhausted");
const timeoutEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_pull_diagnostic_timeout");
const rejectionEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_pull_late_rejection");
const discardedEvents = () =>
	latencyEvents.filter((e) => e.phase === "lsp_pull_late_answer_discarded");

afterEach(() => {
	latencyEvents.length = 0;
	resetDegradationLedger();
	vi.useRealTimers();
});

describe("#1773 a budget-exhausted pull skips instead of dispatching an unwinnable request", () => {
	it("budgetMs <= 0: no request send, one skip record, no timeout record", async () => {
		const state = pullState();
		const sendRequest = installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ kind: "full", items: [] }),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 0, { pullOnly: true });

		const diagnosticCalls = sendRequest.mock.calls.filter(
			([method]) => method === "textDocument/diagnostic",
		);
		expect(diagnosticCalls).toHaveLength(0);
		expect(skipEvents()).toHaveLength(1);
		expect(timeoutEvents()).toHaveLength(0);

		const event = skipEvents()[0];
		expect(event.filePath).toBe(TEST_KEY);
		expect(event.metadata).toMatchObject({
			identifier: "bare",
			remainingBudgetMs: 0,
			server: "typescript",
		});
	});

	it("negative budgetMs also skips (already-exhausted budget, not merely zero)", async () => {
		const state = pullState();
		const sendRequest = installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ kind: "full", items: [] }),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, -50, { pullOnly: true });

		const diagnosticCalls = sendRequest.mock.calls.filter(
			([method]) => method === "textDocument/diagnostic",
		);
		expect(diagnosticCalls).toHaveLength(0);
		expect(skipEvents()).toHaveLength(1);
	});

	it("at the 5ms floor still skips (boundary is inclusive)", async () => {
		const state = pullState();
		const sendRequest = installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ kind: "full", items: [] }),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 5, { pullOnly: true });

		const diagnosticCalls = sendRequest.mock.calls.filter(
			([method]) => method === "textDocument/diagnostic",
		);
		expect(diagnosticCalls).toHaveLength(0);
		expect(skipEvents()).toHaveLength(1);
	});

	// Mutation guard: deleting/loosening the `<=` boundary would make a normal
	// above-floor budget skip too. 6ms is one above the floor and must dispatch
	// a genuine request, same as the pre-existing 20ms/30ms fixtures.
	it("just above the floor (6ms) dispatches a real request, not a skip", async () => {
		const state = pullState();
		const sendRequest = installSendRequest(
			state,
			(method) =>
				method !== "textDocument/diagnostic"
					? Promise.resolve(undefined)
					: new Promise(() => {}), // never resolves -> times out, not skipped
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 6, { pullOnly: true });

		const diagnosticCalls = sendRequest.mock.calls.filter(
			([method]) => method === "textDocument/diagnostic",
		);
		expect(diagnosticCalls).toHaveLength(1);
		expect(skipEvents()).toHaveLength(0);
		expect(timeoutEvents()).toHaveLength(1);
	});
});

describe("#1774 a late server rejection after a pull timeout is a bounded, traced record", () => {
	it("fires exactly one lsp_pull_late_rejection record carrying the error code, server, and elapsed time", async () => {
		const state = pullState();
		installSendRequest(state, async (method) => {
			if (method !== "textDocument/diagnostic") return undefined;
			await wait(80);
			// -32803 (RequestFailed): permanent, unlike -32801 (ContentModified),
			// which `safeSendRequest` retries once and then resolves as `undefined`
			// rather than rejecting — so it would land in the late-ANSWER branch,
			// not this one. -32803 is the code the codebase's own comment
			// (`clients/lsp/client.ts`, `isContentModifiedError`) names as falling
			// through to a real rethrow, which is what this test needs to reach.
			const err = new Error("request failed") as Error & { code: number };
			err.code = -32803;
			throw err;
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		expect(rejectionEvents()).toHaveLength(0); // not settled yet

		await wait(120); // let the abandoned request settle

		expect(rejectionEvents()).toHaveLength(1);
		const event = rejectionEvents()[0];
		expect(event.filePath).toBe(TEST_KEY);
		expect(event.metadata).toMatchObject({
			identifier: "bare",
			server: "typescript",
			code: -32803,
		});
		expect(event.durationMs as number).toBeGreaterThanOrEqual(0);

		// Distinguishable from the late-ANSWER outcome, not conflated with it.
		expect(discardedEvents()).toHaveLength(0);

		const ledger = getDegradationSummary();
		const group = ledger.find((g) => g.kind === "lsp-pull-late-rejection");
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe(TEST_KEY);
	});

	// Mutation guard: a rejection with no numeric/string `code` must still
	// record (never throw / never silently drop) — just without a `code` key.
	it("still records when the rejection carries no error code", async () => {
		const state = pullState();
		installSendRequest(state, async (method) => {
			if (method !== "textDocument/diagnostic") return undefined;
			await wait(80);
			throw new Error("connection reset");
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		await wait(120);

		expect(rejectionEvents()).toHaveLength(1);
		expect(rejectionEvents()[0].metadata).not.toHaveProperty("code");
	});

	// Behavior-unchanged guard: the rejection must stay swallowed. If the
	// instrumentation ever let it surface as an unhandled rejection, this test
	// would fail the whole run (vitest fails on unhandled rejections).
	it("does not change the swallow behavior — no unhandled rejection escapes", async () => {
		const state = pullState();
		installSendRequest(state, async (method) => {
			if (method !== "textDocument/diagnostic") return undefined;
			await wait(30);
			throw new Error("server rejected");
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		await wait(70);

		expect(rejectionEvents()).toHaveLength(1);
	});
});

describe("#1773 class sweep: workspace/diagnostic shares the same budget-exhausted skip", () => {
	function workspacePullState(): LSPClientState {
		return createMockState({
			serverId: "typescript",
			root: "/project",
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "static",
			},
		});
	}

	it("budgetMs <= 0: no workspace/diagnostic dispatch, one skip record, undefined result", async () => {
		const state = workspacePullState();
		const sendRequest = installSendRequest(state, (method) =>
			method !== "workspace/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ items: [] }),
		);

		const result = await clientRequestWorkspaceDiagnostics(state, 0);

		const workspaceCalls = sendRequest.mock.calls.filter(
			([method]) => method === "workspace/diagnostic",
		);
		expect(workspaceCalls).toHaveLength(0);
		expect(result).toBeUndefined();
		expect(skipEvents()).toHaveLength(1);
		expect(timeoutEvents()).toHaveLength(0);
		expect(skipEvents()[0].metadata).toMatchObject({
			server: "typescript",
			remainingBudgetMs: 0,
		});
	});

	it("above the floor still dispatches a real workspace/diagnostic request", async () => {
		const state = workspacePullState();
		const sendRequest = installSendRequest(
			state,
			(method) =>
				method !== "workspace/diagnostic"
					? Promise.resolve(undefined)
					: new Promise(() => {}), // never resolves -> times out, not skipped
		);

		await clientRequestWorkspaceDiagnostics(state, 20);

		const workspaceCalls = sendRequest.mock.calls.filter(
			([method]) => method === "workspace/diagnostic",
		);
		expect(workspaceCalls).toHaveLength(1);
		expect(skipEvents()).toHaveLength(0);
		expect(timeoutEvents()).toHaveLength(1);
	});
});

describe("#1771 a genuine pull timeout counts in the degradation ledger", () => {
	it("increments lsp-pull-diagnostic-timeout with a server+file subject", async () => {
		const state = pullState();
		installSendRequest(
			state,
			(method) =>
				method !== "textDocument/diagnostic"
					? Promise.resolve(undefined)
					: new Promise(() => {}), // never resolves -> genuine timeout
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });

		expect(timeoutEvents()).toHaveLength(1);
		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-pull-diagnostic-timeout",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toContain("typescript");
		expect(group?.latestReasons[0]?.subject).toContain(TEST_KEY);
	});

	it("counts each repeat timeout independently, not a rising-edge-only latch", async () => {
		const state = pullState();
		installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: new Promise(() => {}),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });
		await clientWaitForDiagnostics(state, TEST_FILE, 20, { pullOnly: true });

		expect(timeoutEvents()).toHaveLength(2);
		const group = getDegradationSummary().find(
			(g) => g.kind === "lsp-pull-diagnostic-timeout",
		);
		expect(group?.count).toBe(2);
	});

	// Mutation guard: a SKIPPED pull (budget already exhausted) must never
	// count toward this kind — only a genuinely dispatched-then-abandoned
	// request is a timeout.
	it("does NOT count a budget-exhausted skip toward the timeout kind", async () => {
		const state = pullState();
		installSendRequest(state, (method) =>
			method !== "textDocument/diagnostic"
				? Promise.resolve(undefined)
				: Promise.resolve({ kind: "full", items: [] }),
		);

		await clientWaitForDiagnostics(state, TEST_FILE, 0, { pullOnly: true });

		expect(skipEvents()).toHaveLength(1);
		expect(
			getDegradationSummary().find(
				(g) => g.kind === "lsp-pull-diagnostic-timeout",
			),
		).toBeUndefined();
	});
});
