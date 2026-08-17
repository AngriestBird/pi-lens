/**
 * Regression tests for #1536: a failed grammar download must not latch for
 * the session.
 *
 * `TreeSitterClient.ensureGrammar` de-dupes concurrent fetches of the same
 * grammar via `grammarEnsurePromises`, a `Map<string, Promise<boolean>>`. Pre-
 * fix, that map retained the SETTLED promise forever, so a `false` from one
 * offline moment (DNS hiccup, CDN blip, proxy stall) disabled the language's
 * tree-sitter features for the rest of the process — the #1494 permanent-
 * latch class, in the download domain.
 *
 * The fix evicts the settled entry on resolution and adds a bounded cooldown
 * (the `transientRetryDelayMs` shape from availability-policy.ts) so a
 * hard-down CDN is not re-hit on every parse, while a later demand — once the
 * cooldown expires — gets a fresh attempt.
 */

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const notifyUserDegradation = vi.hoisted(() => vi.fn());
vi.mock("../../clients/user-notify.js", () => ({ notifyUserDegradation }));

type EnsureGrammarClient = {
	ensureGrammar(file: string): Promise<boolean>;
	resolveGrammarFile(file: string): string | undefined;
	grammarsWriteDir(): string | undefined;
	grammarsDir: string;
};

async function makeClient(writeDir: string): Promise<EnsureGrammarClient> {
	const { TreeSitterClient } = await import(
		"../../clients/tree-sitter-client.js"
	);
	const client = new TreeSitterClient() as unknown as EnsureGrammarClient;
	// Force ensureGrammar past the "already on disk" short-circuit and give it
	// a real write dir to fetch into, instead of the real (junctioned)
	// grammars dir the constructor found.
	client.grammarsDir = "";
	vi.spyOn(client, "resolveGrammarFile").mockReturnValue(undefined);
	vi.spyOn(client, "grammarsWriteDir").mockReturnValue(writeDir);
	return client;
}

describe("grammar download retry after failure (#1536)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		resetDegradationLedger();
		notifyUserDegradation.mockClear();
		vi.useFakeTimers();
		env = setupTestEnvironment("pi-lens-grammar-retry-");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		removeTempDirSync(env.tmpDir);
	});

	it("retries a failed grammar download after cooldown and succeeds once the fetch recovers", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-fake-lang.wasm";

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("network unreachable"));

		// First demand: the download fails (transient network error).
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
		expect(getDegradationSummary()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "grammar-blocked", count: 1 }),
			]),
		);
		expect(fs.existsSync(`${env.tmpDir}/${grammarFile}`)).toBe(false);

		// A demand made WHILE the cooldown is still live must not hit the network
		// again — this is the "not hammered" half of the fix. This is also the
		// line that is red on pre-fix code for the opposite reason: pre-fix, the
		// settled `false` promise was cached forever, so this call would return
		// false too, but so would EVERY later call for the rest of the process,
		// even long after the cooldown and after the network recovered.
		expect(await client.ensureGrammar(grammarFile)).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(1); // no re-fetch while cooling down

		// Advance past the cooldown and let the network recover.
		vi.advanceTimersByTime(60_000);
		fetchSpy.mockResolvedValueOnce(
			new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
		);

		expect(await client.ensureGrammar(grammarFile)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fs.existsSync(`${env.tmpDir}/${grammarFile}`)).toBe(true);
	});

	it("shares one fetch across concurrent demands for the same grammar", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-concurrent-lang.wasm";

		let resolveFetch!: (value: Response) => void;
		const fetchGate = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockReturnValue(fetchGate as unknown as Promise<Response>);

		const first = client.ensureGrammar(grammarFile);
		const second = client.ensureGrammar(grammarFile);

		resolveFetch(new Response("no", { status: 500 }));
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult).toBe(false);
		expect(secondResult).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		// Both demands see the same failed outcome from the one shared attempt;
		// the failure notification still fires only once.
		expect(notifyUserDegradation).toHaveBeenCalledTimes(1);
	});

	it("caches a successful grammar download (no re-fetch on the next demand)", async () => {
		const client = await makeClient(env.tmpDir);
		const grammarFile = "tree-sitter-cached-lang.wasm";

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
			);

		expect(await client.ensureGrammar(grammarFile)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(`${env.tmpDir}/${grammarFile}`)).toBe(true);

		// Second demand: the file is now really on disk, so the un-mocked
		// resolveGrammarFile would find it. Simulate that by letting the mock
		// return the real path instead of undefined.
		(client.resolveGrammarFile as ReturnType<typeof vi.fn>).mockReturnValue(
			`${env.tmpDir}/${grammarFile}`,
		);
		expect(await client.ensureGrammar(grammarFile)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
