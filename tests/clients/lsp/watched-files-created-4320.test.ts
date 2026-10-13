/**
 * #4320: Pyrefly keeps a failed `import new_module` lookup after the module is
 * created, and only a `workspace/didChangeWatchedFiles` Created (1) clears it —
 * Changed (2) does not. `handleNotifyOpenOnce` probed `access(file)` AFTER the
 * file was on disk and sent Changed for every file that existed, so a file pi
 * (or anything else) had just created was announced as an edit.
 *
 * These cases drive the real `createLSPClient` over a real stdio JSON-RPC wire
 * to the fake server and read the frames the SERVER received, echoed back
 * through `$/test/watchedFilesReceived`. State table (event the server gets):
 *
 *   file written after the client started, first open  -> Created (1)
 *   file that existed before the client started        -> Changed (2)
 *   Created, then Changed for the same URI in a window -> Created (1)
 *   reopen of a young file after close                 -> Created (1) again
 *   document with no file on disk (unsaved buffer)     -> Created (1)
 *   silent (cascade) open                              -> nothing
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import type { launchLSP } from "../../../clients/lsp/launch.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { setupTestEnvironment, useTrackedTempDirs } from "../test-utils.js";

useTrackedTempDirs("pi-lens-4320-");

type Frame = Array<{ uri: string; type: number }>;

describe("didChangeWatchedFiles type for an opened file (#4320)", () => {
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let dir: string;
	let received: Frame[] = [];
	let waiters: Array<{ count: number; resolve: () => void }> = [];

	/**
	 * A file that predates the client by far more than the birth margin: this
	 * test file itself, checked out before any test in the run started.
	 */
	const OLD_FILE = fileURLToPath(import.meta.url);

	const startClient = async (): Promise<void> => {
		proc = await spawnFakeLspServer({
			cwd: dir,
			env: { ...process.env, FAKE_LSP_ECHO_WATCHED_FILES: "1" },
		});
		client = await createLSPClient({
			serverId: "fake-watch-4320",
			process: proc,
			root: dir,
		});
		client.connection.onNotification(
			"$/test/watchedFilesReceived",
			(params: { changes: Frame }) => {
				received.push(params.changes);
				for (const waiter of waiters) {
					if (received.length >= waiter.count) waiter.resolve();
				}
			},
		);
	};

	/** Resolves once the server has received `count` frames in total. */
	const framesReceived = (count: number): Promise<Frame[]> =>
		new Promise((resolve) => {
			if (received.length >= count) resolve(received);
			else waiters.push({ count, resolve: () => resolve(received) });
		});

	/**
	 * Opens a second new file after the case under test. Its frame is a later
	 * debounce window, and the wire is ordered, so every frame the case could
	 * still emit has arrived by the time the sentinel's frame does.
	 */
	const sentinelFrame = async (): Promise<Frame> => {
		const file = path.join(dir, "sentinel.ts");
		fs.writeFileSync(file, "export const sentinel = 1;\n");
		await client!.notify.open(
			file,
			"export const sentinel = 1;\n",
			"typescript",
		);
		const frames = await framesReceived(received.length + 1);
		const last = frames.at(-1)!;
		expect(last).toEqual([{ uri: pathToFileURL(file).href, type: 1 }]);
		return last;
	};

	beforeEach(() => {
		received = [];
		waiters = [];
		dir = setupTestEnvironment("pi-lens-4320-").tmpDir;
	});

	afterEach(async () => {
		try {
			await client?.shutdown();
		} catch {
			/* ignore */
		}
		try {
			if (proc) await stopLSP(proc);
		} catch {
			/* ignore */
		}
		client = undefined;
		proc = undefined;
	});

	/** The Created rows need a filesystem that reports a birth time. */
	const requireBirthtime = (ctx: { skip: (note?: string) => never }) => {
		const probe = path.join(dir, "birthtime-probe");
		fs.writeFileSync(probe, "x");
		if (!(fs.statSync(probe).birthtimeMs > 0)) {
			ctx.skip("filesystem reports no birth time");
		}
	};

	it("sends Created for a file written after the client started", async (ctx) => {
		requireBirthtime(ctx);
		await startClient();
		const file = path.join(dir, "new_module.ts");
		fs.writeFileSync(file, "export const created = 1;\n");

		await client!.notify.open(
			file,
			fs.readFileSync(file, "utf8"),
			"typescript",
		);

		expect((await framesReceived(1))[0]).toEqual([
			{ uri: pathToFileURL(file).href, type: 1 },
		]);
	});

	it("sends Changed for a file that existed before the client started", async () => {
		await startClient();

		await client!.notify.open(
			OLD_FILE,
			fs.readFileSync(OLD_FILE, "utf8"),
			"typescript",
		);

		expect((await framesReceived(1))[0]).toEqual([
			{ uri: pathToFileURL(OLD_FILE).href, type: 2 },
		]);
	});

	it("keeps Created when a Changed for the same file lands in the same window", async (ctx) => {
		requireBirthtime(ctx);
		await startClient();
		const file = path.join(dir, "both.ts");
		fs.writeFileSync(file, "export const both = 1;\n");

		await client!.notify.open(
			file,
			fs.readFileSync(file, "utf8"),
			"typescript",
		);
		client!.notify.watchedFileChange(file, 2);

		expect((await framesReceived(1))[0]).toEqual([
			{ uri: pathToFileURL(file).href, type: 1 },
		]);
		// one frame for the window, not a Created followed by a Changed
		await sentinelFrame();
		expect(received).toHaveLength(2);
	});

	it("sends Created again when a young file is reopened after close", async (ctx) => {
		requireBirthtime(ctx);
		await startClient();
		const file = path.join(dir, "reopened.ts");
		fs.writeFileSync(file, "export const r = 1;\n");
		await client!.notify.open(file, "export const r = 1;\n", "typescript");
		await framesReceived(1);

		await client!.closeDocument(file);
		await client!.notify.open(file, "export const r = 1;\n", "typescript");

		expect((await framesReceived(2))[1]).toEqual([
			{ uri: pathToFileURL(file).href, type: 1 },
		]);
	});

	it("sends Created for a document that has no file on disk", async () => {
		await startClient();
		const file = path.join(dir, "unsaved.ts");

		await client!.notify.open(file, "export const u = 1;\n", "typescript");

		expect((await framesReceived(1))[0]).toEqual([
			{ uri: pathToFileURL(file).href, type: 1 },
		]);
	});

	it("sends nothing for a silent open of a new file", async (ctx) => {
		requireBirthtime(ctx);
		await startClient();
		const file = path.join(dir, "silent.ts");
		fs.writeFileSync(file, "export const s = 1;\n");

		await client!.notify.open(
			file,
			"export const s = 1;\n",
			"typescript",
			false,
			true,
		);
		await sentinelFrame();

		// the sentinel's frame is the only one: the silent open sent none
		expect(received).toHaveLength(1);
	});
});
