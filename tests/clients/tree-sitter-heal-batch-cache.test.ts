/**
 * #3834: a clean compile that heals a rule must not leave a cached batch that
 * was built while that rule was charged and skipped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWebTreeSitter } from "../../clients/deps/web-tree-sitter.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import {
	TreeSitterClient,
	wasmQueryInput,
} from "../../clients/tree-sitter-client.js";
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
		) => Promise<{
			entries: Array<{ queryDef: TreeSitterQuery }>;
			key: string;
			query: { delete: () => void };
		} | null>;
		loadLanguage: (languageId: string) => Promise<unknown>;
		queryBatchCache: { size: number };
		queryBatchInputs: { size: number };
		parseFileAndUse: (...args: unknown[]) => Promise<unknown>;
		wasmInputKey: (input: { languageId: string; source: string }) => string;
		trappedInputs: Map<string, { traps: number; by?: string; source?: string }>;
		clearWasmInput: (input: {
			languageId: string;
			source: string;
			caller?: string;
		}) => void;
	};

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP;
});

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
		expect(state.queryBatchInputs.size).toBe(1);

		release();
		expect(await pendingRaw).not.toBeNull();
		expect(state.queryBatchCache.size).toBe(0);
		expect(state.queryBatchInputs.size).toBe(0);
		const healed = await state.compileQueryBatch([rule, healthyRule], "python");
		expect(healed?.entries.map(({ queryDef }) => queryDef.id)).toEqual([
			"r1",
			"healthy",
		]);
	});

	it("invalidates only batches containing the healed input and bounds their mirrors", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const alternateRule = {
			...healthyRule,
			id: "alternate",
			name: "alternate",
		};
		const first = await state.compileQueryBatch([healthyRule], "python");
		const second = await state.compileQueryBatch([alternateRule], "python");
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(state.queryBatchCache.size).toBe(2);
		expect(state.queryBatchInputs.size).toBe(2);

		const firstInput = wasmQueryInput(first!.key);
		state.trappedInputs.set(state.wasmInputKey(firstInput), {
			traps: 1,
			by: undefined,
			source: firstInput.source,
		});
		const firstDelete = vi.spyOn(first!.query, "delete");
		const secondDelete = vi.spyOn(second!.query, "delete");
		state.clearWasmInput(firstInput);

		expect(state.queryBatchCache.size).toBe(1);
		expect(state.queryBatchInputs.size).toBe(1);
		expect(firstDelete).toHaveBeenCalledTimes(1);
		expect(secondDelete).not.toHaveBeenCalled();

		process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP = "1";
		await state.compileQueryBatch([alternateRule, healthyRule], "python");
		expect(state.queryBatchCache.size).toBe(1);
		expect(state.queryBatchInputs.size).toBe(1);
	});

	it("defers native disposal until an in-flight batch consumer releases it", async () => {
		const client = new TreeSitterClient();
		expect(await client.init()).toBe(true);
		const state = defs(client);
		const content = "def f():\n    return 1\n";
		const filePath = "tree-sitter-heal-batch.py";
		const initial = await client.runQueriesOnFile(
			[healthyRule],
			filePath,
			"python",
			{},
			content,
		);
		expect(initial.map(({ queryDef }) => queryDef.id)).toEqual(["healthy"]);

		const cache = client as unknown as {
			queryBatchCache: Map<
				string,
				{
					key: string;
					query: { delete: () => void };
				}
			>;
		};
		const batch = [...cache.queryBatchCache.values()][0];
		expect(batch).toBeDefined();
		const deleteQuery = vi.spyOn(batch.query, "delete");
		const batchInput = wasmQueryInput(batch.key);
		state.trappedInputs.set(state.wasmInputKey(batchInput), {
			traps: 1,
			by: undefined,
			source: batchInput.source,
		});

		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const parse = state.parseFileAndUse.bind(client);
		vi.spyOn(state, "parseFileAndUse").mockImplementation(async (...args) => {
			await held;
			return parse(...args);
		});
		const pending = client.runQueriesOnFile(
			[healthyRule],
			filePath,
			"python",
			{},
			content,
		);
		await Promise.resolve();
		const trapsBefore =
			getDegradationSummary().find((group) => group.kind === "wasm-trap")
				?.count ?? 0;
		state.clearWasmInput(batchInput);
		expect(deleteQuery).not.toHaveBeenCalled();
		expect(
			getDegradationSummary().find((group) => group.kind === "wasm-trap")
				?.count,
		).toBeGreaterThan(trapsBefore);

		release();
		expect((await pending).map(({ queryDef }) => queryDef.id)).toEqual([
			"healthy",
		]);
		expect(deleteQuery).toHaveBeenCalledTimes(1);
	});
});
