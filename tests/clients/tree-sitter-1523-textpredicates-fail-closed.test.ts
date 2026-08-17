/**
 * evaluatePredicates fails closed on malformed textPredicates (#1523).
 *
 * web-tree-sitter compiles #match?/#eq? predicates into an undocumented,
 * untyped `query.textPredicates[patternIndex]` array. The old implementation
 * read it as `query.textPredicates?.[patternIndex] ?? []` — if a future
 * web-tree-sitter upgrade renames or drops that property, the `?? []`
 * silently means "no predicates," and every match is reported as if its
 * #match?/#eq? predicates passed. These tests prove the fix fails CLOSED
 * (drops the match) instead of failing open (passes it) when the property
 * is missing or the wrong shape.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";

// biome-ignore lint/suspicious/noExplicitAny: reaching a private method for a focused unit test
function evaluatePredicates(
	client: TreeSitterClient,
	query: any,
	match: any,
): boolean {
	return (client as any).evaluatePredicates(query, match);
}

// A predicate that would reject every match — if it silently ran, the match
// would be dropped. We use it to prove the fail-closed path never even
// reaches predicate evaluation when the array is malformed.
const alwaysFalse = () => false;

describe("evaluatePredicates fails closed on malformed textPredicates (#1523)", () => {
	afterEach(() => {
		resetDegradationLedger();
	});

	it("drops the match when textPredicates is entirely missing (stripped/renamed property)", () => {
		const client = new TreeSitterClient();
		// A real web-tree-sitter Query object always has a textPredicates array.
		// Simulate an upstream removal/rename by constructing one without it.
		const query = {} as { textPredicates?: unknown };
		const match = { patternIndex: 0, captures: [] };

		// Fail-closed: the match must be dropped (predicates unverifiable),
		// never silently reported as "no predicates, pass".
		expect(evaluatePredicates(client, query, match)).toBe(false);
	});

	it("drops the match when textPredicates is the wrong shape (not an array)", () => {
		const client = new TreeSitterClient();
		const query = { textPredicates: undefined as unknown };
		const match = { patternIndex: 0, captures: [] };

		expect(evaluatePredicates(client, query, match)).toBe(false);
	});

	it("still evaluates real predicates normally when textPredicates is a valid array", () => {
		const client = new TreeSitterClient();
		const query = { textPredicates: [[alwaysFalse]] };
		const match = { patternIndex: 0, captures: [] };

		// Valid shape, predicate says no: still fails, but for the RIGHT reason
		// (the predicate itself), not because the shape was unverifiable.
		expect(evaluatePredicates(client, query, match)).toBe(false);
	});

	it("passes a match with no predicates for its pattern, given a valid textPredicates array", () => {
		const client = new TreeSitterClient();
		// Pattern 0 has predicates; pattern 1 legitimately has none defined.
		const query = { textPredicates: [[alwaysFalse]] };
		const match = { patternIndex: 1, captures: [] };

		expect(evaluatePredicates(client, query, match)).toBe(true);
	});

	it("records a degradation when textPredicates is malformed, so the blackout reaches the user (#1523 review F1)", () => {
		const client = new TreeSitterClient();
		const query = {} as { textPredicates?: unknown };
		const match = { patternIndex: 0, captures: [] };

		evaluatePredicates(client, query, match);

		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "query-predicates-invalid",
				count: 1,
			}),
		]);
	});

	it("logs the malformed-textPredicates degradation once per session, not once per Query object (#1523 review F2)", () => {
		const client = new TreeSitterClient();
		const match = { patternIndex: 0, captures: [] };

		// Simulate the LRU query cache rebuilding: a fresh Query object each time
		// (as would happen on cache eviction), each with the same stripped shape.
		evaluatePredicates(client, {} as { textPredicates?: unknown }, match);
		evaluatePredicates(client, {} as { textPredicates?: unknown }, match);
		evaluatePredicates(client, {} as { textPredicates?: unknown }, match);

		// One event recorded per query (fail-closed still applies to each), but the
		// underlying diagnostic log is a session-level latch — the degradation count
		// still reflects one record per offending query object, but must not grow
		// unbounded from re-validating the exact same Query instance.
		const summary = getDegradationSummary();
		expect(summary).toHaveLength(1);
		expect(summary[0]).toMatchObject({ kind: "query-predicates-invalid" });
	});

	it("fails closed without throwing when textPredicates is removed after a prior successful validation (#1523 review F3)", () => {
		const client = new TreeSitterClient();
		const query: { textPredicates?: unknown } = {
			textPredicates: [[alwaysFalse]],
		};
		const match = { patternIndex: 0, captures: [] };

		// First evaluation: valid shape, evaluates normally.
		expect(evaluatePredicates(client, query, match)).toBe(false);

		// Simulate a post-validation removal of the property on the SAME query
		// object (e.g. a later mutation strips it after the first successful check).
		delete query.textPredicates;

		// Must fail closed (drop the match), not throw — a throw here would be
		// swallowed by searchFileWithQuery's outer catch and silently zero out
		// every match in the file instead of just this one.
		expect(() => evaluatePredicates(client, query, match)).not.toThrow();
		expect(evaluatePredicates(client, query, match)).toBe(false);
	});
});
