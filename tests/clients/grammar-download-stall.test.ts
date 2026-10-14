/**
 * #4342 round 3: `downloadGrammarDetailed`'s stall bound.
 *
 * Round 2 bounded each test-setup prefetch with a 30 s wall-clock
 * `AbortSignal.timeout`. On a 5 Mbps link the 26 parallel fetches shared the
 * bandwidth and 10 of them hit the wall clock while bytes were still arriving.
 * The bound now counts only time with no bytes: a stalled transfer fails, a slow
 * one completes. The black-hole and mid-body cases run against a real local
 * socket, so the abort travels through the real fetch; the slow-link case uses
 * fake timers and a body stream the test feeds by hand.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadGrammarDetailed } from "../../clients/grammar-source.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

/** Not in the pinned manifest, so only the magic and length checks apply. */
const GRAMMAR = "tree-sitter-stall-fixture.wasm";
const STALL_MS = 200;
const WASM_HEADER = new Uint8Array([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

describe("grammar download stall bound (#4342)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let server: http.Server | undefined;
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-grammar-stall-");
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
		removeTempDirSync(env.tmpDir);
	});

	/** Serve every request with `handler` on a loopback port, and send the
	 * grammar fetch there instead of the CDN. */
	async function serveGrammar(handler: http.RequestListener): Promise<void> {
		const local = http.createServer(handler);
		local.on("connection", (socket) => socket.on("error", () => {}));
		await new Promise<void>((resolve) =>
			local.listen(0, "127.0.0.1", () => resolve()),
		);
		server = local;
		const { port } = local.address() as AddressInfo;
		vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
			realFetch(`http://127.0.0.1:${port}/${GRAMMAR}`, init),
		);
	}

	// Recurrence: without the bound a black-holed CDN holds the fetch until
	// undici's 300 s headers timeout, far past the 5 s test timeout.
	it("fails a connection that never answers within the stall bound", async () => {
		await serveGrammar(() => {
			/* accept, never answer */
		});

		const result = await downloadGrammarDetailed(env.tmpDir, GRAMMAR, {
			stallMs: STALL_MS,
		});

		expect(result).toEqual({
			ok: false,
			retryable: true,
			reason: `No bytes arrived for ${STALL_MS} ms — a stalled transfer.`,
		});
		expect(fs.existsSync(path.join(env.tmpDir, GRAMMAR))).toBe(false);
	});

	// Recurrence: a bound that only covered the headers would let a body that
	// stops mid-transfer hang the read.
	it("fails a body that stops arriving mid-transfer", async () => {
		await serveGrammar((_req, res) => {
			res.writeHead(200, { "content-length": "100000" });
			res.write(WASM_HEADER);
		});

		const result = await downloadGrammarDetailed(env.tmpDir, GRAMMAR, {
			stallMs: STALL_MS,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("stalled transfer");
		expect(fs.existsSync(path.join(env.tmpDir, GRAMMAR))).toBe(false);
	});

	// Recurrence: round 2's wall-clock limit, which failed a 5 Mbps link that
	// was still delivering. Each chunk lands just inside the bound, and the
	// whole transfer takes nearly twice it.
	it("completes a slow body that keeps delivering past the bound", async () => {
		vi.useFakeTimers();
		let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
		let aborted = false;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					feed = controller;
					// The fetch contract: aborting the request's signal errors
					// its body stream.
					init?.signal?.addEventListener("abort", () => {
						aborted = true;
						controller.error(init.signal?.reason);
					});
				},
			});
			return new Response(body, { status: 200 });
		});
		/** Send a chunk, or end the body, unless the download already aborted. */
		const offer = (chunk?: Uint8Array): void => {
			if (aborted) return;
			if (chunk) feed?.enqueue(chunk);
			else feed?.close();
		};

		const pending = downloadGrammarDetailed(env.tmpDir, GRAMMAR, {
			stallMs: STALL_MS,
		});
		await vi.advanceTimersByTimeAsync(STALL_MS - 20);
		offer(WASM_HEADER.slice(0, 4));
		await vi.advanceTimersByTimeAsync(STALL_MS - 20);
		offer(WASM_HEADER.slice(4));
		await vi.advanceTimersByTimeAsync(STALL_MS - 20);
		offer();

		expect(await pending).toEqual({ ok: true, retryable: true });
		expect(fs.readFileSync(path.join(env.tmpDir, GRAMMAR))).toEqual(
			Buffer.from(WASM_HEADER),
		);
	});
});
