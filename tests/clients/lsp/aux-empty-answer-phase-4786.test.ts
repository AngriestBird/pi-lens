/**
 * #4786: the phase rule's other cells, driven through the production
 * publish handler (`setupIncomingHandlers`) and open path (`handleNotifyOpen`)
 * on fake timers, because the debounce and resync orderings need arrival
 * orders a wire cannot schedule deterministically. The wire repro is
 * `tests/clients/lsp/opengrep-late-empty-4786.test.ts`.
 *
 * The rule: within one phase (the server's rules generation, the client's own
 * send of the path), an auxiliary's UNVERSIONED empty publication never
 * supersedes its stored or pending finding. Recurrence each cell prevents:
 * - a new send (a resync after a fix) or a rules refresh must still clear the
 *   finding, or a fixed file keeps a stale finding (rows 4 and 5 of the r1
 *   state table);
 * - a language server and a versioned publication keep last write wins, or
 *   the rule leaks past its population;
 * - the refusal is counted once per occurrence and recorded once per path and
 *   phase, or a refused empty is silent or floods the sink.
 */
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { getRecentLoggedPhases } from "../../../clients/latency-logger.js";
import {
	handleNotifyOpen,
	publicationCountsForPath,
	setupIncomingHandlers,
	type LSPClientState,
	type LSPDiagnostic,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const FILE = "/project/app.py";
const KEY = normalizeMapKey(FILE);
const URI = pathToFileURL(FILE).href;
const SETTLE_MS = 1_000;

const FINDING: LSPDiagnostic = {
	severity: 1,
	code: "subprocess-shell-true",
	message: "subprocess call with shell=True",
	range: { start: { line: 3, character: 4 }, end: { line: 3, character: 20 } },
};

type Publish = (params: {
	uri: string;
	diagnostics?: LSPDiagnostic[];
	version?: number;
}) => void;

function arm(
	serverId: string,
	serverRole: "auxiliary" | "language",
): { state: LSPClientState; publish: Publish; rulesRefreshed: () => void } {
	const state = createMockState({
		serverId,
		serverRole,
		diagnosticEmitter: new EventEmitter(),
	});
	setupIncomingHandlers(state, {});
	const calls = vi.mocked(state.connection.onNotification).mock
		.calls as unknown as Array<[string, (params?: unknown) => void]>;
	const handler = (method: string) => {
		const found = calls.find((call) => call[0] === method)?.[1];
		expect(found).toBeDefined();
		return found as (params?: unknown) => void;
	};
	const refreshed = handler("semgrep/rulesRefreshed");
	return {
		state,
		publish: handler("textDocument/publishDiagnostics") as Publish,
		rulesRefreshed: () => refreshed(undefined),
	};
}

const stored = (state: LSPClientState) =>
	(state.pushDiagnostics.get(KEY) ?? []).map((d) => d.code);

function refusals() {
	return getDegradationSummary().find(
		(group) => group.kind === "lsp-auxiliary-empty-after-finding",
	);
}

describe("#4786 an auxiliary's empty within its finding's phase", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetDegradationLedger();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("refuses an empty in the finding's phase, counts it, and records it once per path and phase", async () => {
		const { state, publish, rulesRefreshed } = arm("opengrep", "auxiliary");
		rulesRefreshed();
		await handleNotifyOpen(state, FILE, "a", "python", false, true);
		publish({ uri: URI, diagnostics: [FINDING] });
		publish({ uri: URI, diagnostics: [] });
		vi.advanceTimersByTime(SETTLE_MS);
		publish({ uri: URI, diagnostics: [] });
		vi.advanceTimersByTime(SETTLE_MS);

		expect(stored(state)).toEqual(["subprocess-shell-true"]);
		// Every publication answered the send it was owed (#3482): the cap is
		// the one send, so the count settles there rather than going missing.
		expect(publicationCountsForPath(state, KEY)).toEqual({
			sent: 1,
			published: 1,
		});
		const group = refusals();
		expect(group?.count).toBe(2);
		expect(group?.latestReasons).toEqual([
			{
				subject: `opengrep:empty-after-finding:${KEY}:1:1`,
				reason:
					"empty publish dropped: a finding from the same rules generation and send stands (count: 2)",
			},
		]);
		const rows = getRecentLoggedPhases().filter(
			(row) => row.phase === "lsp_publish_dropped_empty_after_finding",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata).toMatchObject({
			serverId: "opengrep",
			phase: "1:1",
		});
	});

	it("stores repeated empties with no finding and records no refusal", async () => {
		// Only a finding stands for its phase: an empty that stamped it would
		// record a refusal "after a finding" that never existed.
		const { state, publish, rulesRefreshed } = arm("opengrep", "auxiliary");
		rulesRefreshed();
		await handleNotifyOpen(state, FILE, "a", "python", false, true);
		publish({ uri: URI, diagnostics: [] });
		vi.advanceTimersByTime(SETTLE_MS);
		publish({ uri: URI, diagnostics: [] });
		vi.advanceTimersByTime(SETTLE_MS);
		expect(stored(state)).toEqual([]);
		expect(state.pushDiagnostics.has(KEY)).toBe(true);
		expect(refusals()).toBeUndefined();
	});

	it("stores the empty after a rules refresh (row 4: new rules may clear)", async () => {
		const { state, publish, rulesRefreshed } = arm("opengrep", "auxiliary");
		rulesRefreshed();
		await handleNotifyOpen(state, FILE, "a", "python", false, true);
		publish({ uri: URI, diagnostics: [FINDING] });
		vi.advanceTimersByTime(SETTLE_MS);
		expect(stored(state)).toEqual(["subprocess-shell-true"]);

		rulesRefreshed();
		publish({ uri: URI, diagnostics: [] });
		vi.advanceTimersByTime(SETTLE_MS);
		expect(stored(state)).toEqual([]);
		expect(state.pushDiagnostics.has(KEY)).toBe(true);
		expect(refusals()).toBeUndefined();
	});

	for (const preserveDiagnostics of [false, true]) {
		it(`stores the empty answer to a new send (row 5: a fix landed; preserveDiagnostics=${preserveDiagnostics})`, async () => {
			const { state, publish, rulesRefreshed } = arm("opengrep", "auxiliary");
			rulesRefreshed();
			await handleNotifyOpen(state, FILE, "a", "python", false, true);
			publish({ uri: URI, diagnostics: [FINDING] });
			vi.advanceTimersByTime(SETTLE_MS);
			expect(stored(state)).toEqual(["subprocess-shell-true"]);

			// opengrep resyncs with didClose+didOpen (`reopenOnResync`).
			await handleNotifyOpen(
				state,
				FILE,
				"b",
				"python",
				preserveDiagnostics,
				true,
			);
			expect(publicationCountsForPath(state, KEY).sent).toBe(2);
			// The stamp holds only paths the diagnostics store holds: a clearing
			// resync drops it with the cache (shape 46, an unbounded per-path map).
			expect(state.nonEmptyAnswerPhases?.has(KEY)).toBe(preserveDiagnostics);
			publish({ uri: URI, diagnostics: [] });
			vi.advanceTimersByTime(SETTLE_MS);
			expect(stored(state)).toEqual([]);
			expect(state.pushDiagnostics.has(KEY)).toBe(true);
			expect(refusals()).toBeUndefined();
		});
	}

	it("keeps last write wins for a versioned auxiliary publication", async () => {
		const { state, publish } = arm("ast-grep", "auxiliary");
		await handleNotifyOpen(state, FILE, "a", "python", false, true);
		publish({ uri: URI, diagnostics: [FINDING], version: 0 });
		vi.advanceTimersByTime(SETTLE_MS);
		publish({ uri: URI, diagnostics: [], version: 0 });
		vi.advanceTimersByTime(SETTLE_MS);
		expect(stored(state)).toEqual([]);
		expect(state.pushDiagnostics.has(KEY)).toBe(true);
		expect(refusals()).toBeUndefined();
	});

	it("keeps last write wins for a language server", async () => {
		const { state, publish } = arm("pyright", "language");
		await handleNotifyOpen(state, FILE, "a", "python", false, true);
		publish({ uri: URI, diagnostics: [FINDING] });
		vi.advanceTimersByTime(SETTLE_MS);
		publish({ uri: URI, diagnostics: [] });
		vi.advanceTimersByTime(SETTLE_MS);
		expect(stored(state)).toEqual([]);
		expect(state.pushDiagnostics.has(KEY)).toBe(true);
		expect(state.nonEmptyAnswerPhases?.size ?? 0).toBe(0);
		expect(refusals()).toBeUndefined();
	});
});
