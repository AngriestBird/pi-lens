/**
 * Batched rule execution (#675).
 *
 * A project scan ran one tree walk PER RULE — ~34 walks per file. `runQueriesOnFile`
 * compiles the rule set into a single multi-pattern query and walks once, so these
 * tests pin the two things that batching could plausibly break: the results must be
 * identical to the per-rule path, and each rule must keep its own post-filter,
 * metavars and result cap.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetSharedTreeSitterClientForTests,
	getSharedTreeSitterClient,
} from "../../clients/tree-sitter-shared.js";
import type { TreeSitterQuery } from "../../clients/tree-sitter-query-loader.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	_resetSharedTreeSitterClientForTests();
});

const rule = (
	id: string,
	query: string,
	extra: Partial<TreeSitterQuery> = {},
): TreeSitterQuery =>
	({
		id,
		name: id,
		severity: "warning",
		language: "typescript",
		message: id,
		query,
		metavars: [],
		filePath: `rules/tree-sitter-queries/typescript/${id}.yml`,
		...extra,
	}) as TreeSitterQuery;

const SOURCE = `
function alpha(a, b) { console.log(a); return b; }
class Beta { method() { console.log("x"); } }
const gamma = (v) => console.log(v);
`;

const RULES = [
	rule("calls", "(call_expression) @CALL", { metavars: ["CALL"] }),
	rule("functions", "(function_declaration) @FN", { metavars: ["FN"] }),
	rule("classes", "(class_declaration) @CLS", { metavars: ["CLS"] }),
	rule("arrows", "(arrow_function) @ARROW", { metavars: ["ARROW"] }),
];

describe("runQueriesOnFile", () => {
	it("returns exactly what one-query-at-a-time returns, in rule order", async () => {
		const env = setupTestEnvironment("pi-lens-batch-eq-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "a.ts", SOURCE);
		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);

		const perRule: Array<{ id: string; line: number; text: string }> = [];
		for (const def of RULES) {
			for (const match of await client.runQueryOnFile(def, file, "typescript")) {
				perRule.push({ id: def.id, line: match.line, text: match.matchedText });
			}
		}

		const batched = (
			await client.runQueriesOnFile(RULES, file, "typescript")
		).map(({ queryDef, match }) => ({
			id: queryDef.id,
			line: match.line,
			text: match.matchedText,
		}));

		expect(batched).toEqual(perRule);
		expect(batched.length).toBeGreaterThan(0);
	});

	it("applies maxResults per rule, not across the batch", async () => {
		const env = setupTestEnvironment("pi-lens-batch-cap-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "b.ts", SOURCE);
		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);

		const capped = await client.runQueriesOnFile(RULES, file, "typescript", {
			maxResults: 1,
		});
		const byRule = new Map<string, number>();
		for (const { queryDef } of capped) {
			byRule.set(queryDef.id, (byRule.get(queryDef.id) ?? 0) + 1);
		}
		for (const count of byRule.values()) expect(count).toBe(1);
		// More than one rule survives the cap — it is per rule, not global.
		expect(byRule.size).toBeGreaterThan(1);
	});

	it("drops a rule whose post_filter has no implementation", async () => {
		const env = setupTestEnvironment("pi-lens-batch-filter-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "c.ts", SOURCE);
		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);

		const ghost = rule("ghost-filter", "(call_expression) @CALL", {
			metavars: ["CALL"],
			post_filter: "definitely_not_implemented",
		});
		// Failing OPEN here is what made `duplicate-function-arg` report 59
		// phantom duplicates: the rule's own condition was never evaluated.
		expect(await client.runQueriesOnFile([ghost], file, "typescript")).toEqual(
			[],
		);
		expect(await client.runQueryOnFile(ghost, file, "typescript")).toEqual([]);
	});

	it("skips a rule that cannot compile without losing the rest of the batch", async () => {
		const env = setupTestEnvironment("pi-lens-batch-bad-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "d.ts", SOURCE);
		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);

		const broken = rule("broken", "(this_node_type_does_not_exist) @X", {
			metavars: ["X"],
		});
		const found = await client.runQueriesOnFile(
			[broken, ...RULES],
			file,
			"typescript",
		);
		expect(found.some(({ queryDef }) => queryDef.id === "broken")).toBe(false);
		expect(found.some(({ queryDef }) => queryDef.id === "calls")).toBe(true);
	});
});
