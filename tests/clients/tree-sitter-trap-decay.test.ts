/**
 * #3678 F-A and F-C. F-A: a healthy parse or compile of an input that once
 * trapped must drop that input's trap entry, or two separate one-off traps on
 * one unchanged input charge it and skip it for the rest of the process. F-C:
 * the symbol extractor's own query compile must be keyed by query source, or
 * one always-trapping query spends the process budget on every extractor init
 * and the fourth init poisons the runtime.
 *
 * Each test builds its own `TreeSitterClient`, so each gets a fresh
 * `WASM_TRAP_BUDGET`. The shared singleton's budget is process-wide and pinned
 * in tests/clients/tree-sitter-wasm-trap.test.ts and the review-graph suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	TreeSitterClient,
	WASM_TRAP_BUDGET,
} from "../../clients/tree-sitter-client.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
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

function pythonFile(content = "def f():\n    return 1\n"): string {
	const env = setupTestEnvironment("pi-lens-trap-decay-");
	cleanups.push(env.cleanup);
	return createTempFile(env.tmpDir, "m.py", content);
}

async function liveClient() {
	const onAbort = vi.fn();
	const client = new TreeSitterClient(false, onAbort);
	expect(await client.init()).toBe(true);
	return { client, onAbort };
}

function wasmTrapReasons(): string[] {
	return (
		getDegradationSummary()
			.find((group) => group.kind === "wasm-trap")
			?.latestReasons.map((row) => row.reason) ?? []
	);
}

/**
 * A language handle that traps while `state.on`, the way a grammar whose query
 * compile always traps (`new Query(language, source)` reads `language[0]`)
 * does. Toggled per call to model a one-off compile trap followed by a healthy
 * compile of the same query source.
 */
function trappingLanguage(
	client: TreeSitterClient,
	state: { on: boolean },
): void {
	const internals = client as unknown as {
		loadLanguage: (languageId: string) => Promise<unknown>;
	};
	const realLoad = internals.loadLanguage.bind(client);
	vi.spyOn(internals, "loadLanguage").mockImplementation(async (languageId) =>
		state.on
			? {
					get 0(): number {
						throw trap();
					},
				}
			: realLoad(languageId),
	);
}

describe("trap entry decay (#3678 F-A)", () => {
	it("drops an input's entry after a healthy parse, so a later one-off trap is not charged", async () => {
		const { client, onAbort } = await liveClient();
		const file = pythonFile();
		const boom = () => {
			throw trap();
		};

		expect(
			await client.withParsedTree(file, "python", undefined, boom),
		).toEqual({
			parsed: false,
			wasmTrap: "retry",
		});
		// The healthy parse of the SAME input is the decay event.
		expect(
			(await client.withParsedTree(file, "python", undefined, () => 1)).parsed,
		).toBe(true);
		expect(
			(await client.withParsedTree(file, "python", undefined, () => 1)).parsed,
		).toBe(true);

		// Without decay the entry is still `1` here, so this second trap is
		// charged and every later parse is skipped.
		expect(
			await client.withParsedTree(file, "python", undefined, boom),
		).toEqual({
			parsed: false,
			wasmTrap: "retry",
		});
		expect(wasmTrapReasons().some((r) => r.startsWith("input charged:"))).toBe(
			false,
		);
		// The input is not skipped: a healthy parse still runs.
		expect(
			(await client.withParsedTree(file, "python", undefined, () => 1)).parsed,
		).toBe(true);
		expect(onAbort).not.toHaveBeenCalled();
	});

	it("drops a pattern query's entry after a successful compile (#3678 F-A)", async () => {
		const { client } = await liveClient();
		const internals = client as unknown as {
			compileQuery: (pattern: string, languageId: string) => Promise<unknown>;
			queryCache: Map<string, unknown>;
		};
		const state = { on: false };
		trappingLanguage(client, state);
		const compile = () => {
			internals.queryCache.clear();
			return internals.compileQuery("(function_definition) @fn", "python");
		};

		state.on = true;
		expect(await compile()).toBeNull(); // trap: budget 1, entry retry
		state.on = false;
		expect(await compile()).not.toBeNull(); // success: the decay event
		state.on = true;
		expect(await compile()).toBeNull(); // trap again
		state.on = false;
		// With decay the entry is gone, so this compile runs; without it the
		// previous trap charged the query and this returns null uncompiled.
		expect(await compile()).not.toBeNull();
	});

	it("drops a raw query's entry after a successful compile (#3678 F-A)", async () => {
		const { client } = await liveClient();
		const internals = client as unknown as {
			compileRawQuery: (
				queryId: string,
				queryStr: string,
				metavars: string[],
				languageId: string,
			) => Promise<unknown>;
			queryCache: Map<string, unknown>;
		};
		const state = { on: false };
		trappingLanguage(client, state);
		const compile = () => {
			internals.queryCache.clear();
			return internals.compileRawQuery(
				"rule-1",
				"(function_definition) @fn",
				["fn"],
				"python",
			);
		};

		state.on = true;
		expect(await compile()).toBeNull(); // trap: budget 1, entry retry
		state.on = false;
		expect(await compile()).not.toBeNull(); // success: the decay event
		state.on = true;
		expect(await compile()).toBeNull(); // trap again
		state.on = false;
		// With decay the entry is gone, so this compile runs; without it the
		// previous trap charged the query and this returns null uncompiled.
		expect(await compile()).not.toBeNull();
	});
});

describe("query-compile keying (#3678 F-C)", () => {
	it("charges a repeated compile trap to its query source instead of the budget", () => {
		const onAbort = vi.fn();
		const client = new TreeSitterClient(false, onAbort);
		const extractor = new TreeSitterSymbolExtractor("python", client);
		const compileQuery = (
			extractor as unknown as {
				compileQuery: (
					Query: new () => never,
					language: unknown,
					src: string,
					label: string,
				) => unknown;
			}
		).compileQuery.bind(extractor);
		class TrappingQuery {
			constructor() {
				throw trap();
			}
		}
		const src = "(function_definition) @fn";

		const outcomes: unknown[] = [];
		for (let i = 0; i < WASM_TRAP_BUDGET + 2; i++) {
			outcomes.push(compileQuery(TrappingQuery as never, {}, src, "defs"));
		}

		// The first trap spends one budget unit; every later one is charged to
		// the same query source, so the runtime never aborts and each attempt
		// still returns the documented null.
		expect(outcomes).toEqual([null, null, null, null, null]);
		expect(onAbort).not.toHaveBeenCalled();
	});
});
