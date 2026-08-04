import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_exitFlushersForTest,
	createNdjsonLogger,
} from "../../clients/ndjson-logger.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir: string;
let logFile: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-logger-"));
	logFile = path.join(tmpDir, "test.log");
});

afterEach(() => {
	vi.restoreAllMocks();
	removeTempDirSync(tmpDir);
});

function readLines(file: string): string[] {
	return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
}

describe("createNdjsonLogger", () => {
	it("serializes a burst of log() calls in enqueue order", async () => {
		const appendFile = vi.spyOn(fs.promises, "appendFile");
		const logger = createNdjsonLogger({ filePath: logFile });
		for (let i = 0; i < 50; i++) {
			logger.log({ i });
		}
		await logger.flush();

		const lines = readLines(logFile);
		expect(lines).toHaveLength(50);
		lines.forEach((line, idx) => {
			expect(JSON.parse(line)).toEqual({ i: idx });
		});
		expect(appendFile).toHaveBeenCalledTimes(1);
	});

	it("splits batches at truncate boundaries", async () => {
		const appendFile = vi.spyOn(fs.promises, "appendFile");
		const writeFile = vi.spyOn(fs.promises, "writeFile");
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ before: 1 });
		logger.log({ before: 2 });
		logger.truncate();
		logger.log({ after: 1 });
		logger.log({ after: 2 });
		await logger.flush();

		expect(appendFile).toHaveBeenCalledTimes(2);
		expect(writeFile).toHaveBeenCalledTimes(1);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ after: 1 },
			{ after: 2 },
		]);
	});

	it("flush() resolves only once everything enqueued is on disk", async () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ a: 1 });
		logger.log({ b: 2 });
		await logger.flush();
		expect(readLines(logFile)).toHaveLength(2);

		// A second batch after a completed flush drains independently.
		logger.log({ c: 3 });
		await logger.flush();
		expect(readLines(logFile)).toHaveLength(3);
	});

	it("lazily creates the parent directory", async () => {
		const nested = path.join(tmpDir, "a", "b", "c", "deep.log");
		const logger = createNdjsonLogger({ filePath: nested });
		logger.log({ ok: true });
		await logger.flush();
		expect(fs.existsSync(nested)).toBe(true);
	});

	it("rotates to <file>.1 at the byte threshold", async () => {
		const backup = `${logFile}.1`;
		// Small threshold so a couple of lines trip it.
		const logger = createNdjsonLogger({ filePath: logFile, maxBytes: 40 });

		logger.log({ payload: "first-entry-under-threshold" });
		await logger.flush();
		// Below threshold on the first write — no rotation yet.
		expect(fs.existsSync(backup)).toBe(false);

		logger.log({ payload: "second-entry-trips-rotation" });
		await logger.flush();
		// The pre-existing file exceeded maxBytes, so it was renamed to .1 and
		// the new line landed in a fresh primary file.
		expect(fs.existsSync(backup)).toBe(true);
		expect(readLines(logFile)).toHaveLength(1);
	});

	it("never rotates when maxBytes is absent", async () => {
		const backup = `${logFile}.1`;
		const logger = createNdjsonLogger({ filePath: logFile });
		for (let i = 0; i < 100; i++) {
			logger.log({ padding: "x".repeat(100), i });
		}
		await logger.flush();
		expect(fs.existsSync(backup)).toBe(false);
		expect(readLines(logFile)).toHaveLength(100);
	});

	it("a truncate op does not race pending writes (clear is serialized)", async () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ before: 1 });
		logger.log({ before: 2 });
		logger.truncate();
		logger.log({ after: 1 });
		await logger.flush();

		// Enqueue order: two writes, truncate (empties file), one write. The
		// truncate cannot jump ahead of the earlier writes, so the final file
		// holds exactly the single post-truncate line.
		const lines = readLines(logFile);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ after: 1 });
	});

	it("append() adds the trailing newline itself", async () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.append('{"raw":true}');
		await logger.flush();
		expect(fs.readFileSync(logFile, "utf-8")).toBe('{"raw":true}\n');
	});

	it("redacts secrets from structured and pre-serialized log lines", async () => {
		const githubToken = `ghp_${"a".repeat(36)}`;
		const jwt = [
			"ey",
			"JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value",
		].join("");
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ message: githubToken });
		logger.append(JSON.stringify({ message: jwt }));
		logger.log({ [githubToken]: true });
		logger.append(
			JSON.stringify({
				message: `before ${["-----BEGIN ", "PRIVATE KEY-----"].join("")}\nprivate material`,
			}),
		);
		await logger.flush();

		const lines = readLines(logFile).map((line) => JSON.parse(line));
		expect(lines).toEqual([
			{ message: "[REDACTED:github-token]" },
			{ message: "[REDACTED:jwt]" },
			{ "[REDACTED:github-token]": true },
			{ message: "before [REDACTED:private-key]" },
		]);
		expect(fs.readFileSync(logFile, "utf-8")).not.toContain(githubToken);
		expect(fs.readFileSync(logFile, "utf-8")).not.toContain(jwt);
	});

	it("flushSync drains buffered lines synchronously (exit-handler path)", () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ buffered: 1 });
		logger.log({ buffered: 2 });
		// Do NOT await drain — call the sync flush directly, as process.on("exit")
		// would. Everything buffered must land on disk.
		logger.flushSync();
		expect(readLines(logFile)).toHaveLength(2);
	});

	it("flushSync writes the in-flight batch (dupes over drops) and never removes newer lines", async () => {
		// #935 review: if the process dies before an in-flight threadpool
		// append issues, a skipped prefix would drop the whole batch. flushSync
		// therefore rewrites the in-flight batch synchronously — a duplicate
		// line when the async write ALSO landed is the accepted cost, a dropped
		// line is not. The async completion handler must still leave the
		// (now-empty) queue alone.
		let release: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		const appendFile = vi
			.spyOn(fs.promises, "appendFile")
			.mockImplementationOnce(async (file, data, options) => {
				await realAppendFile(file, data, options);
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			});
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ async: 1 });

		// Let the first append reach disk while keeping its promise unresolved,
		// then enqueue a remainder and flush everything synchronously.
		await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));
		logger.log({ sync: 2 });
		logger.flushSync();
		// The in-flight line appears twice (async write landed AND flushSync
		// rewrote it — never-drops), the newer line exactly once.
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ async: 1 },
			{ async: 1 },
			{ sync: 2 },
		]);

		release?.();
		await logger.flush();
		// Async completion must not shift the newer items flushSync already
		// wrote, nor re-write anything.
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ async: 1 },
			{ async: 1 },
			{ sync: 2 },
		]);
	});

	it("registers the logger's flushSync in the shared exit flusher set", () => {
		const before = _exitFlushersForTest().size;
		const logger = createNdjsonLogger({ filePath: logFile });
		// One shared process 'exit' handler flushes all loggers, so we assert the
		// logger's flushSync is enrolled rather than counting process listeners.
		expect(_exitFlushersForTest().size).toBe(before + 1);
		expect(_exitFlushersForTest().has(logger.flushSync)).toBe(true);
	});

	it("keeps a single shared process 'exit' listener regardless of logger count", () => {
		const count = process.listenerCount("exit");
		createNdjsonLogger({ filePath: path.join(tmpDir, "a.log") });
		createNdjsonLogger({ filePath: path.join(tmpDir, "b.log") });
		createNdjsonLogger({ filePath: path.join(tmpDir, "c.log") });
		// No per-logger listener growth — the MaxListeners warning cannot fire.
		expect(process.listenerCount("exit")).toBe(count);
	});

	it("shares the exit listener across module re-evaluation", async () => {
		const count = process.listenerCount("exit");
		vi.resetModules();
		const freshModule = await import("../../clients/ndjson-logger.js");
		freshModule.createNdjsonLogger({ filePath: path.join(tmpDir, "fresh.log") });
		expect(process.listenerCount("exit")).toBe(count);
	});

	it("swallows write errors (best-effort telemetry)", async () => {
		// Point at a path whose parent is a file, so mkdir/append fail.
		const asFile = path.join(tmpDir, "not-a-dir");
		fs.writeFileSync(asFile, "x");
		const logger = createNdjsonLogger({
			filePath: path.join(asFile, "child.log"),
		});
		logger.log({ nope: true });
		await expect(logger.flush()).resolves.toBeUndefined();
	});
});
