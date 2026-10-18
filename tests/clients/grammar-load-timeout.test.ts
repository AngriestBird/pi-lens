/**
 * #4224: a `Language.load` that never settles.
 *
 * `loadLanguage` awaited the loader with no bound, so a hung wasm load held
 * its caller for good, and `compileQueryBatch` kept that caller's build as the
 * in-flight record every later caller for the same rule set joined. The rule
 * set for that language then stayed stuck for the whole process. The loader is
 * bounded now: a timeout takes the existing `Language.load` failure path, so
 * the build settles, its record clears, and the grammar's cooldown stops each
 * later call from waiting out the bound again.
 *
 * The loader is the only fake in the code under test. `loadLanguage`,
 * `compileQueryBatch`, the failure record and the cooldown are the production
 * code, the user notifier is the real seam wired to a recorder, and the bound
 * is the shared constant, so a bound that only looks right on a short fake
 * clock cannot pass.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_setGrammarManifestForTests,
	GRAMMAR_LOAD_TIMEOUT_MS,
} from "../../clients/grammar-source.js";
import type { TreeSitterQuery } from "../../clients/tree-sitter-query-loader.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

/** A valid wasm preamble under a real grammar filename: `resolveGrammarFile`
 * vouches for it, and the faked loader decides what happens next. */
const WASM_HEADER = Buffer.from([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);
/** The same preamble with a different length: the file a re-download leaves. */
const REPLACEMENT_WASM = Buffer.from([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xde, 0xad,
]);
const GRAMMAR_FILE = "tree-sitter-python.wasm";

type LoadClient = {
	loadLanguage(languageId: string): Promise<unknown>;
	resolveGrammarFile(file: string): string | undefined;
	compileQueryBatch(
		queryDefs: TreeSitterQuery[],
		languageId: string,
	): Promise<unknown>;
	queryBatchBuilds: Map<string, unknown>;
	grammarSourceDirs(): string[];
	grammarsWriteDir(): string | undefined;
	grammarsDir: string;
	ParserClass: unknown;
	LanguageLoader: { load: (path: string) => Promise<unknown> };
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

/** Loads that stay pending until teardown releases them. */
const stuckLoads: Array<() => void> = [];

/** A load that does not settle while the test runs: the shape #4224 reports.
 * Teardown settles whatever is left, so no promise outlives its test. */
const stuckLoad = (): Promise<unknown> =>
	new Promise((resolve) => {
		stuckLoads.push(() => resolve(undefined));
	});

describe("Language.load bound (#4224)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let notices: Array<{ message: string; level?: string }>;

	beforeEach(() => {
		resetDegradationLedger();
		notices = [];
		wireUserNotifier(() => (message, level) => {
			notices.push({ message, level });
		});
		// The fixture file's bytes are not the real grammar's, so an empty
		// manifest keeps the pinned-hash check from rejecting them.
		_setGrammarManifestForTests({
			package: "tree-sitter-wasms",
			version: "0.0.0-test",
			grammars: {},
		});
		env = setupTestEnvironment("pi-lens-grammar-load-timeout-");
		fs.writeFileSync(path.join(env.tmpDir, GRAMMAR_FILE), WASM_HEADER);
	});

	afterEach(() => {
		for (const release of stuckLoads.splice(0)) release();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetUserNotifier();
		_setGrammarManifestForTests(undefined);
		removeTempDirSync(env.tmpDir);
	});

	async function makeClient(
		load: (path: string) => Promise<unknown>,
	): Promise<{ client: LoadClient; load: ReturnType<typeof vi.fn> }> {
		const { TreeSitterClient } =
			await import("../../clients/tree-sitter-client.js");
		const client = new TreeSitterClient() as unknown as LoadClient;
		client.grammarsDir = env.tmpDir;
		vi.spyOn(client, "grammarSourceDirs").mockReturnValue([env.tmpDir]);
		vi.spyOn(client, "grammarsWriteDir").mockReturnValue(env.tmpDir);
		client.ParserClass = {};
		const loader = vi.fn(load);
		client.LanguageLoader = { load: loader };
		return { client, load: loader };
	}

	const waiting = Symbol("waiting");
	/** `waiting` while `pending` has not settled; its value once it has. A
	 * pending promise loses a race against an already-resolved one. */
	const peek = <T>(pending: Promise<T>): Promise<T | typeof waiting> =>
		Promise.race([pending, Promise.resolve(waiting)]);

	const grammarLedgerReason = (): string | undefined =>
		getDegradationSummary()
			.find((group) => group.kind === "grammar-blocked")
			?.latestReasons.find((entry) => entry.subject === GRAMMAR_FILE)?.reason;

	// Recurrence: master awaited the loader with no bound, so this call never
	// returned.
	it("returns null at the bound and records the timeout against the grammar", async () => {
		const { client } = await makeClient(stuckLoad);
		vi.useFakeTimers();

		const pending = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS - 1);
		expect(await peek(pending)).toBe(waiting);

		await vi.advanceTimersByTimeAsync(1);
		expect(await peek(pending)).toBeNull();

		const group = getDegradationSummary().find(
			(g) => g.kind === "grammar-blocked",
		);
		expect(group?.count).toBe(1);
		expect(grammarLedgerReason()).toContain("Language.load failed");
		expect(grammarLedgerReason()).toContain(String(GRAMMAR_LOAD_TIMEOUT_MS));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.message).toContain(String(GRAMMAR_LOAD_TIMEOUT_MS));
	});

	// Recurrence: the issue's probe. The second caller joined the first
	// caller's build, and the record never cleared.
	it("settles every coalesced batch caller and clears the in-flight record", async () => {
		const { client, load } = await makeClient(stuckLoad);
		vi.useFakeTimers();

		const first = client.compileQueryBatch([rule], "python");
		const second = client.compileQueryBatch([rule], "python");
		await Promise.resolve();
		expect(client.queryBatchBuilds.size).toBe(1);

		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(first)).toBeNull();
		expect(await peek(second)).toBeNull();
		expect(client.queryBatchBuilds.size).toBe(0);
		expect(load).toHaveBeenCalledTimes(1);
	});

	// Recurrence: a caller after the timeout must get its own answer rather
	// than join the abandoned build, and must not wait out the bound again.
	it("answers a later batch call at once, without re-entering the stuck loader", async () => {
		const { client, load } = await makeClient(stuckLoad);
		// The failed load un-vouches the file, so the next demand asks to re-fetch
		// it; inside the cooldown that must not reach the network.
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
			throw new Error("unexpected network call");
		});
		vi.useFakeTimers();
		const stuck = client.compileQueryBatch([rule], "python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(stuck)).toBeNull();

		// No clock advance: a zero-length tick only lets the microtasks run.
		const later = client.compileQueryBatch([rule], "python");
		await vi.advanceTimersByTimeAsync(0);
		expect(await peek(later)).toBeNull();
		expect(client.queryBatchBuilds.size).toBe(0);
		expect(load).toHaveBeenCalledTimes(1);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(notices).toHaveLength(1);
	});

	// Done when (#4224): a later call can retry. The timeout stops vouching for
	// the file, as any failed load does, so the retry waits for the file's
	// re-download and then loads it.
	it("lets a later call load the language once the grammar file is replaced", async () => {
		const { client } = await makeClient(stuckLoad);
		vi.useFakeTimers();
		const timedOut = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS);
		expect(await peek(timedOut)).toBeNull();
		expect(client.resolveGrammarFile(GRAMMAR_FILE)).toBeUndefined();

		fs.writeFileSync(path.join(env.tmpDir, GRAMMAR_FILE), REPLACEMENT_WASM);
		const language = { name: "python" };
		client.LanguageLoader = { load: vi.fn().mockResolvedValue(language) };

		expect(await client.loadLanguage("python")).toBe(language);
	});

	// Control: the bound must not fire early. A load that settles on the last
	// tick before it is a healthy load, not a failure.
	it("leaves a load that settles inside the bound alone", async () => {
		const language = { name: "python" };
		const { client } = await makeClient(
			() =>
				new Promise((resolve) =>
					setTimeout(() => resolve(language), GRAMMAR_LOAD_TIMEOUT_MS - 1),
				),
		);
		vi.useFakeTimers();

		const pending = client.loadLanguage("python");
		await vi.advanceTimersByTimeAsync(GRAMMAR_LOAD_TIMEOUT_MS - 1);

		expect(await peek(pending)).toBe(language);
		expect(
			getDegradationSummary().find((g) => g.kind === "grammar-blocked"),
		).toBeUndefined();
		expect(notices).toEqual([]);
	});
});
