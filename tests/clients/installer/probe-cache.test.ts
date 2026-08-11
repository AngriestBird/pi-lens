import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.ts");

const mockFsReadFile = vi.hoisted(() => vi.fn());
const mockFsAccess = vi.hoisted(() => vi.fn());
const mockFsStat = vi.hoisted(() => vi.fn());
const mockFsWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsAppendFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsRm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsRename = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWriteFileAtomicAsync = vi.hoisted(() =>
	vi.fn().mockResolvedValue(undefined),
);

vi.mock("node:fs/promises", () => ({
	default: {
		readFile: mockFsReadFile,
		access: mockFsAccess,
		stat: mockFsStat,
		writeFile: mockFsWriteFile,
		mkdir: mockFsMkdir,
		appendFile: mockFsAppendFile,
		rm: mockFsRm,
	},
	readFile: mockFsReadFile,
	access: mockFsAccess,
	stat: mockFsStat,
	writeFile: mockFsWriteFile,
	mkdir: mockFsMkdir,
	appendFile: mockFsAppendFile,
	rm: mockFsRm,
	rename: mockFsRename,
}));

vi.mock("../../../clients/atomic-write.js", () => ({
	writeFileAtomicAsync: mockWriteFileAtomicAsync,
}));

import {
	checkProbeCache,
	flushProbeCache,
	resetProbeCacheStateForTesting,
	updateProbeCache,
} from "../../../clients/installer/index.ts";

const TOOL_ID = "typescript-language-server";
const TOOL_PATH = "/home/user/.pi-lens/tools/node_modules/.bin/typescript-language-server";
const MTIME_MS = 1_700_000_000_000;

function makeCacheJson(overrides: Partial<{ cachedAt: number; mtimeMs: number }> = {}) {
	return JSON.stringify({
		[TOOL_ID]: {
			path: TOOL_PATH,
			mtimeMs: overrides.mtimeMs ?? MTIME_MS,
			cachedAt: overrides.cachedAt ?? Date.now(),
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFsMkdir.mockResolvedValue(undefined);
	mockFsRm.mockResolvedValue(undefined);
	mockFsRename.mockResolvedValue(undefined);
	mockWriteFileAtomicAsync.mockResolvedValue(undefined);
	resetProbeCacheStateForTesting();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("checkProbeCache", () => {
	it("returns undefined when no entry exists for the tool", async () => {
		mockFsReadFile.mockResolvedValue(JSON.stringify({}));

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBeUndefined();
	});

	it("returns undefined and evicts when TTL has expired", async () => {
		const expiredAt = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
		mockFsReadFile.mockResolvedValue(makeCacheJson({ cachedAt: expiredAt }));

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBeUndefined();
		// Entry should be gone from the in-memory cache
		const second = await checkProbeCache(TOOL_ID);
		expect(second).toBeUndefined();
		expect(mockFsAccess).not.toHaveBeenCalled();
	});

	it("returns undefined and evicts when the binary is gone", async () => {
		mockFsReadFile.mockResolvedValue(makeCacheJson());
		mockFsAccess.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBeUndefined();
		expect(mockFsAccess).toHaveBeenCalledWith(TOOL_PATH);
	});

	it("returns undefined and evicts when the binary mtime has changed", async () => {
		mockFsReadFile.mockResolvedValue(makeCacheJson({ mtimeMs: MTIME_MS }));
		mockFsAccess.mockResolvedValue(undefined);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS + 1 }); // different mtime

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBeUndefined();
		expect(mockFsStat).toHaveBeenCalledWith(TOOL_PATH);
	});

	it("returns the cached path when entry is valid", async () => {
		mockFsReadFile.mockResolvedValue(makeCacheJson({ mtimeMs: MTIME_MS }));
		mockFsAccess.mockResolvedValue(undefined);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBe(TOOL_PATH);
	});

	it("skips readFile on the second call (uses in-memory cache)", async () => {
		mockFsReadFile.mockResolvedValue(makeCacheJson({ mtimeMs: MTIME_MS }));
		mockFsAccess.mockResolvedValue(undefined);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await checkProbeCache(TOOL_ID);
		await checkProbeCache(TOOL_ID);

		expect(mockFsReadFile).toHaveBeenCalledTimes(1);
	});
});

describe("updateProbeCache", () => {
	it("populates the in-memory cache so a subsequent checkProbeCache hits without I/O", async () => {
		// No disk cache
		mockFsReadFile.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		// stat for updateProbeCache
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });
		// access + stat for the subsequent checkProbeCache
		mockFsAccess.mockResolvedValue(undefined);

		await updateProbeCache(TOOL_ID, TOOL_PATH);

		const result = await checkProbeCache(TOOL_ID);
		expect(result).toBe(TOOL_PATH);
	});

	it("silently ignores a stat failure", async () => {
		mockFsStat.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);

		await expect(updateProbeCache(TOOL_ID, TOOL_PATH)).resolves.toBeUndefined();
	});

	it("schedules a flush to disk", async () => {
		vi.useFakeTimers();
		mockFsReadFile.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		await vi.advanceTimersByTimeAsync(400);

		expect(mockWriteFileAtomicAsync).toHaveBeenCalledOnce();
		const [, content] = mockWriteFileAtomicAsync.mock.calls[0] as [string, string];
		const written = JSON.parse(content) as Record<string, unknown>;
		expect(written[TOOL_ID]).toMatchObject({ path: TOOL_PATH, mtimeMs: MTIME_MS });
	});

	it("merges a sibling process's newer entry instead of losing it", async () => {
		const siblingTool = "ruff";
		const siblingEntry = {
			path: "/other/process/ruff",
			mtimeMs: MTIME_MS + 2,
			cachedAt: Date.now(),
		};
		mockFsReadFile
			.mockResolvedValueOnce(JSON.stringify({}))
			.mockResolvedValueOnce(JSON.stringify({ [siblingTool]: siblingEntry }));
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		await flushProbeCache();

		const [, content] = mockWriteFileAtomicAsync.mock.calls[0] as [
			string,
			string,
		];
		const written = JSON.parse(content) as Record<string, unknown>;
		expect(written[siblingTool]).toEqual(siblingEntry);
		expect(written[TOOL_ID]).toMatchObject({ path: TOOL_PATH });
	});

	it("recovers a stale lock using its owner age", async () => {
		mockFsMkdir
			.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EEXIST" }))
			.mockResolvedValue(undefined);
		mockFsReadFile
			.mockResolvedValueOnce(JSON.stringify({}))
			.mockResolvedValueOnce(
				JSON.stringify({
					pid: process.pid,
					createdAt: Date.now() - 180_001,
					token: "stale-owner",
				}),
			)
			.mockResolvedValueOnce(
				JSON.stringify({
					pid: process.pid,
					createdAt: Date.now() - 180_001,
					token: "stale-owner",
				}),
			)
			.mockResolvedValueOnce(JSON.stringify({}));
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		await flushProbeCache();
		expect(mockWriteFileAtomicAsync).toHaveBeenCalledOnce();
		console.log("lock mocks", mockFsMkdir.mock.calls, mockFsReadFile.mock.calls, mockFsRename.mock.calls, mockFsRm.mock.calls);
		expect(mockFsRename).toHaveBeenCalled();
		expect(mockFsRm).toHaveBeenCalledWith(
			expect.stringContaining("probe-cache.json.lock.quarantine"),
			expect.objectContaining({ recursive: true, force: true }),
		);
	});

	it("does not wait on a busy lock and retries later while the process remains live", async () => {
		vi.useFakeTimers();
		mockFsReadFile.mockResolvedValue(
			JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "owner" }),
		);
		mockFsMkdir.mockRejectedValue(
			Object.assign(new Error("busy"), { code: "EEXIST" }),
		);

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		const flush = flushProbeCache();
		await vi.advanceTimersByTimeAsync(300);
		expect(await flush).toBe("deferred");
		expect(mockWriteFileAtomicAsync).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(700);
		expect(mockFsMkdir.mock.calls.length).toBeGreaterThan(1);
		expect(mockWriteFileAtomicAsync).not.toHaveBeenCalled();
	});

	it("retains an update that arrives during the atomic write", async () => {
		mockFsReadFile.mockResolvedValue(JSON.stringify({}));
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });
		let injected = false;
		mockWriteFileAtomicAsync.mockImplementation(async () => {
			if (!injected) {
				injected = true;
				await updateProbeCache("late-tool", "/managed/late-tool");
			}
		});

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		expect(await flushProbeCache()).toBe("written-with-pending");
		const first = JSON.parse(
			(mockWriteFileAtomicAsync.mock.calls[0] as [string, string])[1],
		) as Record<string, unknown>;
		expect(first[TOOL_ID]).toBeDefined();
		expect(first["late-tool"]).toBeUndefined();

		await flushProbeCache();
		const second = JSON.parse(
			(mockWriteFileAtomicAsync.mock.calls[1] as [string, string])[1],
		) as Record<string, unknown>;
		expect(second["late-tool"]).toMatchObject({ path: "/managed/late-tool" });
	});
});
