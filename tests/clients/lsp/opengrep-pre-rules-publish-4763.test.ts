/**
 * #4763 — the publish handler's hold on opengrep's EMPTY publish that precedes
 * `semgrep/rulesRefreshed`.
 *
 * The recurrence these cases prevent: opengrep with `--config auto` scans a
 * just-opened document before its rules load ("Rules not loaded yet, not
 * scanning anything"), publishes `[]` for it, and republishes the real result
 * after the notification. The handler cached, stamped and emitted that `[]`
 * like any answer, so the touch ended as `answered` and the findings arrived
 * after the wait: 0 of 86 opengrep aux waits in the field carried findings.
 *
 * The end-to-end proof through the real `lsp_diagnostics` handler and a real
 * stdio wire is `tests/tools/lsp-diagnostics-opengrep-pre-rules-4763.test.ts`.
 * This file drives the production notification handler
 * (`setupIncomingHandlers`) and the production open path (`handleNotifyOpen`)
 * directly, because the ordering and counting cells need arrival orders the
 * wire cannot schedule deterministically. The recorded orders come from
 * `tests/fixtures/opengrep-lsp-trace/auxiliary-first-publish.json`, measured
 * against the real binaries, so the replay is not a double built from the
 * issue's description (AGENTS.md shape 16).
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

import {
	handleNotifyOpen,
	publicationCountsForPath,
	setupIncomingHandlers,
	type LSPClientState,
	type LSPDiagnostic,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { SERVER_DIAGNOSTIC_STRATEGIES } from "../../../clients/lsp/wait-policy/strategies.js";
import { createMockState } from "./mock-client-state.js";

const FILE = "/project/app.py";
const KEY = normalizeMapKey(FILE);
const OPENGREP_DEBOUNCE_MS = 250;

const FINDING: LSPDiagnostic = {
	severity: 1,
	message: "Found 'subprocess' function 'call' with 'shell=True'.",
	range: { start: { line: 4, character: 31 }, end: { line: 4, character: 35 } },
};

interface TraceEvent {
	atMs: number;
	publishedCount?: number;
	notification?: string;
	logMessage?: string;
}
interface TraceRun {
	id: string;
	server: string;
	steps: Array<{ label: string; events: TraceEvent[] }>;
}
const trace = JSON.parse(
	fs.readFileSync(
		path.join(
			path.dirname(new URL(import.meta.url).pathname),
			"../../fixtures/opengrep-lsp-trace/auxiliary-first-publish.json",
		),
		"utf8",
	),
) as { runs: TraceRun[] };
const run = (id: string): TraceRun => {
	const found = trace.runs.find((entry) => entry.id === id);
	if (!found) throw new Error(`no recorded run ${id}`);
	return found;
};
const coldEvents = (id: string): TraceEvent[] => run(id).steps[0]!.events;

type Publish = (params: {
	uri: string;
	diagnostics?: LSPDiagnostic[];
	version?: number;
}) => void;

function armHandler(serverId: string): {
	state: LSPClientState;
	publish: Publish;
	rulesRefreshed: () => void;
	emitted: string[];
} {
	const state = createMockState({
		serverId,
		diagnosticEmitter: new EventEmitter(),
	});
	const emitted: string[] = [];
	state.diagnosticEmitter.on("diagnostics", (changed: string) =>
		emitted.push(changed),
	);
	setupIncomingHandlers(state, {});
	const calls = vi.mocked(state.connection.onNotification).mock
		.calls as unknown as Array<[string, (params?: unknown) => void]>;
	const publish = calls.find(
		(call) => call[0] === "textDocument/publishDiagnostics",
	)?.[1];
	const refreshed = calls.find(
		(call) => call[0] === "semgrep/rulesRefreshed",
	)?.[1];
	expect(publish).toBeDefined();
	expect(refreshed).toBeDefined();
	return {
		state,
		publish: publish as Publish,
		rulesRefreshed: () => refreshed?.(undefined),
		emitted,
	};
}

const uri = (file: string) => pathToFileURL(file).href;
const findings = (count: number): LSPDiagnostic[] =>
	Array.from({ length: count }, () => FINDING);

describe("#4763 opengrep's empty publish before semgrep/rulesRefreshed", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		logLatency.mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("is marked on opengrep and on no other server (the measured population)", () => {
		// Recurrence: a marker copied onto a server whose first publish IS its
		// answer would hold that answer for a notification it never sends. The
		// recorded first publishes of the other auxiliaries carry their findings
		// (ast-grep 3/3 at +30..35 ms after its rules reloaded, zizmor 3/3 at +3 ms,
		// typos 3/3 at +0..1 ms), so none of them is marked.
		const marked = Object.entries(SERVER_DIAGNOSTIC_STRATEGIES)
			.filter(([, strategy]) => strategy.emptyUntilRulesRefreshed === true)
			.map(([serverId]) => serverId);
		expect(marked).toEqual(["opengrep"]);
		for (const id of ["ast-grep-cold", "zizmor-cold", "typos-cold"]) {
			const first = coldEvents(id).find(
				(event) => event.publishedCount !== undefined,
			);
			expect(first?.publishedCount, `${id} first publish`).toBeGreaterThan(0);
		}
	});

	it.each([
		"auto-cold-1",
		"auto-cold-2",
		"auto-cold-3",
		"auto-cold-1.32-1",
		"auto-cold-1.32-2",
		"auto-clean",
		"local-1",
		"local-race",
	])(
		"%s: replays the recorded order, holding only what precedes the notification",
		(id) => {
			const { state, publish, rulesRefreshed, emitted } =
				armHandler("opengrep");
			const events = coldEvents(id);
			let refreshed = false;
			let lastPublishCount = 0;
			for (const event of events) {
				if (event.notification === "semgrep/rulesRefreshed") {
					rulesRefreshed();
					refreshed = true;
				} else if (event.publishedCount !== undefined) {
					publish({
						uri: uri(FILE),
						diagnostics: findings(event.publishedCount),
					});
					lastPublishCount = event.publishedCount;
				}
				vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
				if (!refreshed && event.publishedCount === 0) {
					// An empty publish before the notification: not cached, no stamp,
					// no emit, so it can neither end a wait nor read as "answered".
					expect(state.pushDiagnostics.has(KEY)).toBe(false);
					expect(state.diagnosticsVersionsByPath.get(KEY)).toBeUndefined();
					expect(emitted).toEqual([]);
				}
			}
			// What opengrep said last is what the cache holds, and it was emitted.
			expect(state.pushDiagnostics.get(KEY)).toHaveLength(lastPublishCount);
			expect(emitted.length).toBeGreaterThan(0);
		},
	);

	it("does not hold when the rules loaded first: an empty publish is then a clean answer", () => {
		const { state, publish, rulesRefreshed, emitted } = armHandler("opengrep");
		rulesRefreshed();
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

		expect(state.pushDiagnostics.get(KEY)).toEqual([]);
		expect(emitted).toEqual([KEY]);
	});

	it("never holds a non-empty publish: it is a scan result", () => {
		const { state, publish, emitted } = armHandler("opengrep");
		publish({ uri: uri(FILE), diagnostics: [FINDING] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

		expect(state.pushDiagnostics.get(KEY)).toHaveLength(1);
		expect(emitted).toEqual([KEY]);
	});

	it("does not swallow an empty publish that clears a stored finding", () => {
		// The #3310 hold's own guard, kept: a clear is an answer in any order.
		const { state, publish, emitted } = armHandler("opengrep");
		publish({ uri: uri(FILE), diagnostics: [FINDING] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

		expect(state.pushDiagnostics.get(KEY)).toEqual([]);
		expect(emitted).toEqual([KEY, KEY]);
	});

	it.each(["ast-grep", "typos", "zizmor"])(
		"%s: an empty publish is an answer on its first publish",
		(serverId) => {
			// Recurrence: the hold broadened to every auxiliary would turn each clean
			// file into a wait to the budget. Versioned, as the recorded runs are
			// (version 0 on the first open); a version-less typos `[]` is its
			// close-publish and is dropped for another reason (#3548).
			const { state, publish, emitted } = armHandler(serverId);
			publish({ uri: uri(FILE), diagnostics: [], version: 0 });
			vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

			expect(state.pushDiagnostics.get(KEY)).toEqual([]);
			expect(emitted).toEqual([KEY]);
		},
	);

	it("a respawned client is a new state and holds again", () => {
		const first = armHandler("opengrep");
		first.rulesRefreshed();
		const second = armHandler("opengrep");
		second.publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);

		expect(second.state.rulesRefreshed).not.toBe(true);
		expect(second.state.pushDiagnostics.has(KEY)).toBe(false);
	});

	it("PAIR-REOPEN: two opens before the rules load keep #3482's backlog balanced through the notification", async () => {
		// Opengrep re-scans only on a fresh open, so a second touch inside the
		// rule-load window closes and reopens the document (`reopenOnResync`) and
		// each open gets its own pre-rules `[]`. A held publish must still count
		// as answering its send, or the backlog keeps one send for good and the
		// late-auxiliary drain waits for a publication that never comes.
		const { state, publish, rulesRefreshed } = armHandler("opengrep");
		const counts = () => publicationCountsForPath(state, KEY);

		await handleNotifyOpen(state, FILE, "a", "python", false, true);
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		expect(counts()).toEqual({ sent: 1, published: 1 });
		await handleNotifyOpen(state, FILE, "b", "python", false, true);
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		expect(counts()).toEqual({ sent: 2, published: 2 });
		expect(state.pushDiagnostics.has(KEY)).toBe(false);

		// The notification takes one back, the one republish for the open
		// document restores it: balanced, and the findings are cached.
		rulesRefreshed();
		expect(counts()).toEqual({ sent: 2, published: 1 });
		publish({ uri: uri(FILE), diagnostics: [FINDING] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		expect(counts()).toEqual({ sent: 2, published: 2 });
		expect(state.pushDiagnostics.get(KEY)).toHaveLength(1);
	});

	it("PAIR-SAVE: a save inside the rule-load window expects its own rescan publication and stays balanced", async () => {
		// `rescansOnSave`: didSave makes opengrep scan again, an answer to no send,
		// so the path expects one more publication. Before the rules load that
		// scan publishes `[]` too, and it is held and counted like the open's.
		const { state, publish, rulesRefreshed } = armHandler("opengrep");
		state.saveOptions = { includeText: false };
		const counts = () => publicationCountsForPath(state, KEY);

		await handleNotifyOpen(state, FILE, "a", "python", false, true, true);
		expect(counts()).toEqual({ sent: 2, published: 0 });
		publish({ uri: uri(FILE), diagnostics: [] });
		publish({ uri: uri(FILE), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		expect(counts()).toEqual({ sent: 2, published: 2 });
		expect(state.pushDiagnostics.has(KEY)).toBe(false);

		rulesRefreshed();
		expect(counts()).toEqual({ sent: 2, published: 1 });
		publish({ uri: uri(FILE), diagnostics: [FINDING] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		expect(counts()).toEqual({ sent: 2, published: 2 });
		expect(state.pushDiagnostics.get(KEY)).toHaveLength(1);
	});

	it("reports the held publishes once, on the lsp_rules_refreshed row", () => {
		// Bounded observability: one row per refresh, carrying how many empty
		// publishes the hold dropped. A hold that never releases (rules never load)
		// is visible as `silent` aux outcomes with `publishedCount: 0`, not here.
		const { publish, rulesRefreshed } = armHandler("opengrep");
		publish({ uri: uri(FILE), diagnostics: [] });
		publish({ uri: uri("/project/b.py"), diagnostics: [] });
		vi.advanceTimersByTime(OPENGREP_DEBOUNCE_MS * 2);
		rulesRefreshed();

		const rows = logLatency.mock.calls
			.map(([row]) => row as { phase?: string; metadata?: unknown })
			.filter((row) => row.phase === "lsp_rules_refreshed");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata).toMatchObject({
			serverId: "opengrep",
			heldEmptyPublishes: 2,
		});
	});
});
