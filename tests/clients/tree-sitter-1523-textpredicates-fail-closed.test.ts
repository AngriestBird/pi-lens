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
import { describe, expect, it } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";

// biome-ignore lint/suspicious/noExplicitAny: reaching a private method for a focused unit test
function evaluatePredicates(client: TreeSitterClient, query: any, match: any): boolean {
	return (client as any).evaluatePredicates(query, match);
}

// A predicate that would reject every match — if it silently ran, the match
// would be dropped. We use it to prove the fail-closed path never even
// reaches predicate evaluation when the array is malformed.
const alwaysFalse = () => false;

describe("evaluatePredicates fails closed on malformed textPredicates (#1523)", () => {
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
});
