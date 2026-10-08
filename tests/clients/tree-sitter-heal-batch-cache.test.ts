/**
 * #3834: a clean compile that heals a rule must not leave a cached batch that
 * was built while that rule was charged and skipped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWebTreeSitter } from "../../clients/deps/web-tree-sitter.js";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import type { TreeSitterQuery } from "../../clients/tree-sitter-query-loader.js";

const trap = () => {
	const { WebAssembly } = globalThis as unknown as {
		WebAssembly: { RuntimeError: new (message: string) => Error };
	};
	return new WebAssembly.RuntimeError("table index is out of bounds");
};

const rule: TreeSitterQuery = {
	id: "r1",
	name: "r1",
	severity: "warning",
	category: "test",
	language: "python",
	message: "r1",
	query: "(function_definition) @fn",
	metavars: ["fn"],
	has_fix: false,
	filePath: "",
};

const healthyRule: TreeSitterQuery = {
	...rule,
	id: "healthy",
	name: "healthy",
	query: "(return_statement) @ret",
	message: "healthy",
};

const defs = (client: TreeSitterClient) =>
	client as unknown as {
		compileRawQuery: (
			queryId: string,
			query: string,
			metavars: string[],
			languageId: string,
		) => Promise<unknown>;
		compileQueryBatch: (
			queryDefs: TreeSitterQuery[],
			languageId: string,
		) => Promise<{ entries: Array<{ queryDef: TreeSitterQuery }> } | null>;
		loadLanguage: (languageId: string) => Promise<unknown>;
		queryBatchCache: { size: number };
	};

afterEach(() => vi.restoreAllMocks());

describe("tree-sitter batch cache healing (#3834)", () => {
	it("invalidates a batch that omitted a rule healed by an in-flight raw compile", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const realLoad = state.loadLanguage.bind(client);
		const { Query } = await loadWebTreeSitter();
		const realPatternCount = Query.prototype.patternCount;
		let trapProbe = true;
		vi.spyOn(Query.prototype, "patternCount").mockImplementation(function (
			this: InstanceType<typeof Query>,
		) {
			if (trapProbe) {
				trapProbe = false;
				throw trap();
			}
			return realPatternCount.call(this);
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let loads = 0;
		vi.spyOn(state, "loadLanguage").mockImplementation(async (languageId) => {
			loads++;
			if (loads === 1) {
				return {
					get 0(): number {
						throw trap();
					},
				};
			}
			if (loads === 2) {
				await held;
			}
			return realLoad(languageId);
		});

		// One earlier one-off leaves r1 retryable. The second compile passes its
		// check and remains in flight while the batch builds.
		const compileRaw = () =>
			state.compileRawQuery(rule.id, rule.query, rule.metavars ?? [], "python");
		expect(await compileRaw()).toBeNull();
		const pendingRaw = compileRaw();

		// The probe trap charges r1; the following build skips it and caches a
		// batch without r1 while the raw compile is still held.
		expect(
			await state.compileQueryBatch([rule, healthyRule], "python"),
		).not.toBeNull();
		const degraded = await state.compileQueryBatch(
			[rule, healthyRule],
			"python",
		);
		expect(degraded?.entries.map(({ queryDef }) => queryDef.id)).toEqual([
			"healthy",
		]);
		expect(state.queryBatchCache.size).toBe(1);

		release();
		expect(await pendingRaw).not.toBeNull();
		expect(state.queryBatchCache.size).toBe(0);
		const healed = await state.compileQueryBatch([rule, healthyRule], "python");
		expect(healed?.entries.map(({ queryDef }) => queryDef.id)).toEqual([
			"r1",
			"healthy",
		]);
	});
});
