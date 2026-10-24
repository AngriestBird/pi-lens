import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	classifyTraceOutput,
	extractTraces,
	firstUnmatchedEvent,
	readJsonRecords,
	renderTraceConfig,
	renderTraceModule,
	unsupportedReason,
	type TraceEvent,
} from "../../scripts/trace-validate-session-lifecycle.mjs";

// The JVM half (TLC deciding producible / not-producible) is measured in the
// PR body and docs/adr/0010; it needs the pinned jar, which the Unit tests lane
// does not carry. Everything below is the part that decides WHAT TLC is asked.

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const fixtures = path.join(
	root,
	"tests/fixtures/trace-validation/session-lifecycle",
);
const read = (name: string) =>
	fs.readFileSync(path.join(fixtures, name), "utf8");
type Row = {
	phase: string;
	pid: number;
	metadata: Record<string, unknown>;
};
const recorded = () =>
	readJsonRecords(read("lifecycle-drive.rows.json")) as Row[];

describe("trace validation, session-lifecycle pilot (#3533)", () => {
	// Recurrence prevented: the extractor reading a `logScopeTransition` field
	// that was renamed would turn every real run into an empty, trivially
	// "valid" trace. The fixture is the real lifecycle witness's two processes
	// (tests/real-harness/lifecycle.test.ts); the expected events are written
	// from that test's `expectedTransitions`, not from the extractor.
	it("turns the recorded real lifecycle run into its two processes' events", () => {
		const traces = extractTraces(recorded());
		expect(traces.map((t) => t.rejected)).toEqual([[], []]);
		expect(traces.map((t) => t.events)).toEqual([
			[
				{ a: "retire", k: "reload", scope: 1 },
				{
					a: "begin",
					k: "reload",
					scope: 2,
					role: "primary",
					parent: 1,
					src: "slot",
					sameAs: [1],
				},
				{ a: "retire", k: "new", scope: 2 },
				{
					a: "begin",
					k: "new",
					scope: 3,
					role: "primary",
					parent: 2,
					src: "other",
					sameAs: [],
				},
				{ a: "retire", k: "quit", scope: 3 },
			],
			[
				{ a: "retire", k: "fork", scope: 1 },
				{
					a: "begin",
					k: "fork",
					scope: 2,
					role: "primary",
					parent: 1,
					src: "slot",
					sameAs: [],
				},
				{ a: "retire", k: "quit", scope: 2 },
			],
		]);
	});

	// Recurrence prevented: a gate that lists the spellings it knows to refuse
	// (principles §1, "Gates fail closed"). Every row form the pilot does not
	// model must refuse the trace, not be skipped, or a run with a /tree or a
	// subagent in it would be "checked" with the interesting rows missing.
	it.each([
		["a /tree move", { transition: "tree", reason: "tree" }],
		["a secondary scope", { role: "secondary" }],
		[
			"a started scope ended without a shutdown",
			{ transition: "end", reason: "superseded", scopeId: 2 },
		],
		[
			"a start with no session id",
			{
				transition: "start",
				reason: "reload",
				sessionId: undefined,
				scopeId: 3,
			},
		],
		[
			"a start after a branch move",
			{ transition: "start", reason: "reload", branchEpoch: 1, scopeId: 3 },
		],
		[
			"a start reason the pilot does not model",
			{ transition: "start", reason: "clone", scopeId: 3 },
		],
		[
			"a shutdown reason the pilot does not model",
			{ transition: "shutdown", reason: "idle" },
		],
	])("refuses %s instead of dropping the row", (_name, patch) => {
		const rows = recorded();
		// Row 2 is the first process's shutdown:reload of scope 2.
		rows[2] = {
			...rows[2],
			metadata: { ...rows[2].metadata, ...patch },
		};
		expect(extractTraces(rows)[0]?.rejected).not.toEqual([]);
	});

	// Recurrence prevented: pi's jiti load re-creates the coordinator on
	// /reload, so the successor's `parentScopeId` is its own construction scope
	// (bridge-reload-ts shape, probed 2026-10-24), never the predecessor's
	// ticket. Checking it as a lineage edge would reject every such run.
	it("leaves a re-created coordinator's construction scope out of the lineage", () => {
		const row = (m: Record<string, unknown>) => ({
			phase: "session_scope_transition",
			pid: 7,
			metadata: { role: "primary", branchEpoch: 0, ...m },
		});
		const [trace] = extractTraces([
			row({ transition: "end", reason: "superseded", scopeId: 1 }),
			row({
				transition: "start",
				reason: "startup",
				scopeId: 2,
				parentScopeId: 1,
				sessionId: "s",
				handoffSource: "none",
			}),
			row({ transition: "shutdown", reason: "reload", scopeId: 2 }),
			row({ transition: "end", reason: "superseded", scopeId: 3 }),
			row({
				transition: "start",
				reason: "reload",
				scopeId: 4,
				parentScopeId: 3,
				sessionId: "s",
				handoffSource: "slot",
			}),
		]);
		expect(trace?.rejected).toEqual([]);
		expect(trace?.events[1]).toMatchObject({ a: "begin", scope: 2, parent: 0 });
	});

	// Recurrence prevented: RetireOk's `k \notin used` bound. A second /reload
	// is outside the model's language for a reason that is not drift, and TLC
	// would report it as "not producible"; the pilot says why instead.
	it("names the model bound a repeated retire reason runs into", () => {
		const reload = { a: "retire", k: "reload", scope: 1 } as const;
		expect(unsupportedReason([reload, { ...reload, scope: 2 }])).toMatch(
			/once per behaviour/,
		);
		expect(unsupportedReason([reload])).toBeUndefined();
		expect(unsupportedReason([])).toBe("no events");
	});

	// Recurrence prevented: a value from a row reaching the TLA+ text. The
	// module is built only from validated fields.
	it("renders only validated fields into the TLA+ module", () => {
		const events = extractTraces(recorded())[0]?.events as TraceEvent[];
		const text = renderTraceModule(events);
		expect(text).toContain(
			'[a |-> "begin", k |-> "reload", scope |-> 2, role |-> "primary", parent |-> 1, src |-> "slot", sameAs |-> {1}]',
		);
		expect(() =>
			renderTraceModule([
				{ a: "retire", k: 'reload"], x |-> [', scope: 1 },
			] as TraceEvent[]),
		).toThrow(/bad retire event/);
		// The #4815 continuation renders as an event but the module has no
		// disjunct that can match it: the model has no action for it.
		expect(text).not.toContain('ev.a = "continue"');
	});

	// Recurrence prevented: a second copy of the as-built constants drifting
	// from switch-pins.json. The config is Merged.cfg's own text.
	it("derives the trace config from Merged.cfg", () => {
		const base = fs.readFileSync(
			path.join(root, "formal/session-lifecycle/Merged.cfg"),
			"utf8",
		);
		const config = renderTraceConfig(base, 5);
		const fixParts = base.split("\n").find((l) => l.includes("FixParts ="));
		expect(config).toContain(fixParts as string);
		expect(config).toContain("    MaxSteps = 5");
		expect(config).toContain("    Writers = {}");
		expect(config).toContain("SPECIFICATION TSpec\nINVARIANT NotDone\n");
		expect(config).not.toMatch(/INVARIANTS|\* expect/);
		expect(() =>
			renderTraceConfig(base.replace("expect: pass", "expect: violated X"), 5),
		).toThrow(/no longer expects pass/);
	});

	// Recurrence prevented: reading TLC's inverted verdict the wrong way round.
	// The strings are the literal lines of the 2026-10-24 measured runs.
	it("reads NotDone violated as producible and a clean finish as not", () => {
		expect(
			classifyTraceOutput(
				"Error: Invariant NotDone is violated.\nThe behavior up to this point is:",
			),
		).toEqual({ status: "producible" });
		expect(
			classifyTraceOutput(
				"Model checking completed. No error has been found.\nThe depth of the complete state graph search is 3.\n",
			),
		).toEqual({ status: "not-producible", searchDepth: 3 });
		expect(classifyTraceOutput("Error: parsing failed")).toMatchObject({
			status: "error",
		});
	});

	// Recurrence prevented: the unobserved session_before_fork level. Reading
	// the raw depth named event 3 (retire quit) for a drift at event 2.
	it("places the first unmatched event past the hidden before-fork level", () => {
		const events = extractTraces(recorded())[1]?.events as TraceEvent[];
		expect(firstUnmatchedEvent(events, 3)).toBe(2);
		expect(firstUnmatchedEvent(events, 4)).toBe(3);
		const reload = extractTraces(recorded())[0]?.events as TraceEvent[];
		expect(firstUnmatchedEvent(reload, 2)).toBe(2);
	});

	// The acceptance case of #3533: the #4815 interleaving as events.
	it("ships the #4815 shapes as the two event fixtures", () => {
		const transitions = JSON.parse(read("reload-no-continuation.events.json"));
		const withContinuation = JSON.parse(
			read("reload-ctx-continuation-4815.events.json"),
		);
		expect(withContinuation.slice(0, transitions.length)).toEqual(transitions);
		expect(withContinuation.at(-1)).toEqual({
			a: "continue",
			scope: 1,
			effect: "ctx-read",
		});
	});
});
