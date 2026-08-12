import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.ts");

const statSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	statSync: statSyncMock,
}));

import {
	evictBareCommandAvailabilityMemo,
	isCommandAvailable,
	resetBareCommandAvailabilityMemo,
} from "../../../clients/installer/index.ts";

const savedPath = process.env.PATH;

describe("bare-command PATH availability memo", () => {
	beforeEach(() => {
		process.env.PATH = ["memo-path-a", "memo-path-b"].join(path.delimiter);
		resetBareCommandAvailabilityMemo();
		statSyncMock.mockReset();
		statSyncMock.mockImplementation((candidate: unknown) => {
			if (String(candidate).includes("memo-path-b")) {
				return { isFile: () => true, size: 1 };
			}
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
	});

	afterEach(() => {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		resetBareCommandAvailabilityMemo();
	});

	it("walks PATH once until reset or spawn-failure eviction", async () => {
		for (let i = 0; i < 5; i += 1) {
			expect(await isCommandAvailable("memo-tool")).toBe(true);
		}
		const callsPerWalk = process.platform === "win32" ? 5 : 2;
		expect(statSyncMock).toHaveBeenCalledTimes(callsPerWalk);

		process.env.PATH = ["memo-path-a", "memo-path-b", "memo-path-c"].join(
			path.delimiter,
		);
		expect(await isCommandAvailable("memo-tool")).toBe(true);
		expect(statSyncMock).toHaveBeenCalledTimes(callsPerWalk * 2);

		resetBareCommandAvailabilityMemo();
		expect(await isCommandAvailable("memo-tool")).toBe(true);
		expect(statSyncMock).toHaveBeenCalledTimes(callsPerWalk * 3);

		evictBareCommandAvailabilityMemo("memo-tool");
		expect(await isCommandAvailable("memo-tool")).toBe(true);
		expect(statSyncMock).toHaveBeenCalledTimes(callsPerWalk * 4);
	});
});
