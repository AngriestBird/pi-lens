/**
 * #3707: the two `compileQueryBatch` compile sites (the per-rule probe and the
 * combined compile) are charged per query source, and a batch built across a
 * trap is not cached.
 *
 * Recurrences these pin (each fails on `origin/master` 1a66d8f31):
 * - a query that traps deterministically on compile spent one budget unit every
 *   time its batch was rebuilt (LRU eviction, a rule edit), so the fourth
 *   rebuild aborted the runtime (the #3605 shape, at the two sites #3706 left
 *   unkeyed);
 * - a trap within budget skipped the rule (or nulled the batch) and
 *   `cacheQueryBatch` then cached that degraded result for the process, so one
 *   transient trap silenced the rule until restart.
 *
 * Every test drives the real client, a real python grammar and a real compiled
 * `Query`; only the trap is injected, at `Query.prototype.patternCount` (the
 * wasm boundary), so the probe and the combined compile can be trapped
 * independently by the captures the compiled query holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { loadWebTreeSitter } from "../../clients/deps/web-tree-sitter.js";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import type { TreeSitterQuery } from "../../clients/tree-sitter-query-loader.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};
const trap = () => new WebAssembly.RuntimeError("table index is out of bounds");

const cleanups: Array<() => void> = [];
beforeEach(() => resetDegradationLedger());
afterEach(() => {
	vi.restoreAllMocks();
	while (cleanups.length) cleanups.pop()?.();
	resetDegradationLedger();
});

function pythonFile(): string {
	const env = setupTestEnvironment("pi-lens-batch-trap-");
	cleanups.push(env.cleanup);
	return createTempFile(env.tmpDir, "m.py", "def f():\n    return 1\n");
}

async function liveClient() {
	const onAbort = vi.fn();
	const client = new TreeSitterClient(false, onAbort);
	expect(await client.init()).toBe(true);
	const internals = client as unknown as {
		queryBatchCache: Map<string, unknown>;
	};
	return { client, onAbort, evict: () => internals.queryBatchCache.clear() };
}

function rule(id: string, capture: string): TreeSitterQuery {
	return {
		id,
		name: id,
		severity: "warning",
		category: "test",
		language: "python",
		message: id,
		query: `(function_definition) @${capture}`,
		metavars: [capture],
		has_fix: false,
		filePath: "",
	};
}

/**
 * Traps a compiled query's `patternCount()` (read by the probe and by the
 * combined compile inside their try blocks) while `state.on(captureNames)` is
 * true. `calls()` counts every `patternCount` call, i.e. every compile.
 */
async function trapPatternCount(state: {
	on: (captureNames: string[]) => boolean;
}) {
	const { Query } = await loadWebTreeSitter();
	const realPatternCount = Query.prototype.patternCount;
	let calls = 0;
	vi.spyOn(Query.prototype, "patternCount").mockImplementation(function (
		this: InstanceType<typeof Query>,
	) {
		calls++;
		if (state.on(this.captureNames)) throw trap();
		return realPatternCount.call(this);
	});
	return { calls: () => calls };
}

async function countWalks() {
	const { Query } = await loadWebTreeSitter();
	const realMatches = Query.prototype.matches;
	let walks = 0;
	vi.spyOn(Query.prototype, "matches").mockImplementation(function (
		this: InstanceType<typeof Query>,
		...args: Parameters<typeof realMatches>
	) {
		walks++;
		return realMatches.apply(this, args);
	});
	return { walks: () => walks };
}

const ids = (results: Array<{ queryDef: TreeSitterQuery }>): string[] =>
	results.map((r) => r.queryDef.id);

/** The budget left: traps `reportWasmAbort` still absorbs before it reports the abort. */
function remainingBudget(client: TreeSitterClient): number {
	let absorbed = 0;
	while (!client.reportWasmAbort(trap())) absorbed++;
	return absorbed;
}

function wasmTrapReasons(): string[] {
	return (
		getDegradationSummary()
			.find((group) => group.kind === "wasm-trap")
			?.latestReasons.map((row) => row.reason) ?? []
	);
}

describe("a deterministic compile trap on a rebuilt batch (#3707)", () => {
	it("does not abort on a deterministic probe trap across six rebuilds", async () => {
		const { client, onAbort, evict } = await liveClient();
		await trapPatternCount({ on: (names) => names.includes("trap_me") });
		const file = pythonFile();
		const set = [rule("ok", "fn"), rule("poisoned", "trap_me")];

		const seen: string[][] = [];
		for (let round = 0; round < 6; round++) {
			evict();
			seen.push(ids(await client.runQueriesOnFile(set, file, "python")));
		}

		// Master: every rebuild's probe trap spends a unit; the 4th aborts.
		expect(onAbort).not.toHaveBeenCalled();
		expect(seen).toEqual(Array.from({ length: 6 }, () => ["ok"]));
		// One unit for the whole poisoned rule, however often its batch rebuilt.
		expect(remainingBudget(client)).toBe(2);
	});

	it("does not abort on a deterministic combined-compile trap across six rebuilds", async () => {
		const { client, onAbort, evict } = await liveClient();
		await trapPatternCount({
			on: (names) => names.includes("a_cap") && names.includes("b_cap"),
		});
		const file = pythonFile();
		const set = [rule("a", "a_cap"), rule("b", "b_cap")];

		const seen: string[][] = [];
		for (let round = 0; round < 6; round++) {
			evict();
			seen.push(ids(await client.runQueriesOnFile(set, file, "python")));
		}

		// Every probe is healthy and only the combined compile traps, so the
		// per-rule fallback still returns both rules each round.
		expect(onAbort).not.toHaveBeenCalled();
		expect(seen).toEqual(Array.from({ length: 6 }, () => ["a", "b"]));
		expect(remainingBudget(client)).toBe(2);
	});

	it("does not abort when rule edits rebuild batches holding a poisoned rule", async () => {
		const { client, onAbort } = await liveClient();
		await trapPatternCount({ on: (names) => names.includes("trap_me") });
		const file = pythonFile();

		// A rule edit changes the rule set's identity (a new batch key) but not
		// the poisoned rule's own source, so it is one poisoned query source.
		for (let round = 0; round < 6; round++) {
			await client.runQueriesOnFile(
				[rule(`ok-${round}`, "fn"), rule("poisoned", "trap_me")],
				file,
				"python",
			);
		}

		expect(onAbort).not.toHaveBeenCalled();
		expect(remainingBudget(client)).toBe(2);
	});
});

describe("a transient compile trap does not degrade the batch for the process (#3707)", () => {
	it("runs a rule again after a one-off probe trap", async () => {
		const { client, onAbort, evict } = await liveClient();
		const state = { trapping: true };
		await trapPatternCount({
			on: (names) => state.trapping && names.includes("trap_me"),
		});
		const file = pythonFile();
		const set = [rule("ok", "fn"), rule("flaky", "trap_me")];

		// The trap skips the rule for this build.
		expect(ids(await client.runQueriesOnFile(set, file, "python"))).toEqual([
			"ok",
		]);
		state.trapping = false;
		// Master cached that degraded batch: "flaky" never ran again.
		expect(ids(await client.runQueriesOnFile(set, file, "python"))).toEqual([
			"ok",
			"flaky",
		]);

		// A success decayed the rule's entry: the next one-off trap is not
		// charged (a second trap on a stale entry would be), so the rule runs
		// again after it too.
		state.trapping = true;
		evict();
		await client.runQueriesOnFile(set, file, "python");
		state.trapping = false;
		expect(ids(await client.runQueriesOnFile(set, file, "python"))).toEqual([
			"ok",
			"flaky",
		]);
		expect(wasmTrapReasons().some((r) => r.startsWith("input charged:"))).toBe(
			false,
		);
		expect(onAbort).not.toHaveBeenCalled();
	});

	it("builds the combined batch again after a one-off compile trap", async () => {
		const { client, onAbort } = await liveClient();
		const state = { trapping: true };
		await trapPatternCount({
			on: (names) =>
				state.trapping && names.includes("a_cap") && names.includes("b_cap"),
		});
		const walks = await countWalks();
		const file = pythonFile();
		const set = [rule("a", "a_cap"), rule("b", "b_cap")];

		// The trapped combined compile falls back to one walk per rule.
		await client.runQueriesOnFile(set, file, "python");
		expect(walks.walks()).toBe(2);
		state.trapping = false;
		// Master cached the null: two walks again, for the process lifetime.
		await client.runQueriesOnFile(set, file, "python");
		await client.runQueriesOnFile(set, file, "python");
		expect(walks.walks()).toBe(2 + 1 + 1);
		expect(onAbort).not.toHaveBeenCalled();
	});
});

describe("batches that did not trap are still cached (#3707)", () => {
	it("caches a healthy batch", async () => {
		const { client } = await liveClient();
		const compiles = await trapPatternCount({ on: () => false });
		const file = pythonFile();
		const set = [rule("a", "a_cap"), rule("b", "b_cap")];

		await client.runQueriesOnFile(set, file, "python");
		const afterFirst = compiles.calls();
		await client.runQueriesOnFile(set, file, "python");
		await client.runQueriesOnFile(set, file, "python");

		expect(afterFirst).toBeGreaterThan(0);
		expect(compiles.calls()).toBe(afterFirst);
	});

	it("caches a batch whose rule does not compile on this grammar", async () => {
		const { client } = await liveClient();
		const compiles = await trapPatternCount({ on: () => false });
		const file = pythonFile();
		// A grammar error is deterministic, not a wasm trap: caching it is right.
		const invalid = { ...rule("invalid", "x"), query: "(no_such_node) @x" };
		const set = [rule("ok", "fn"), invalid];

		expect(ids(await client.runQueriesOnFile(set, file, "python"))).toEqual([
			"ok",
		]);
		const afterFirst = compiles.calls();
		await client.runQueriesOnFile(set, file, "python");

		expect(compiles.calls()).toBe(afterFirst);
	});

	it("hashes no input while a healthy batch builds and hits the cache", async () => {
		const { client, evict } = await liveClient();
		const key = vi.spyOn(
			client as unknown as { wasmInputKey: (input: unknown) => string },
			"wasmInputKey",
		);
		const file = pythonFile();
		const set = [rule("a", "a_cap"), rule("b", "b_cap")];

		await client.runQueriesOnFile(set, file, "python");
		await client.runQueriesOnFile(set, file, "python");
		evict();
		await client.runQueriesOnFile(set, file, "python");

		expect(key).not.toHaveBeenCalled();
	});
});
