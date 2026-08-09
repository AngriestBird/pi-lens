import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const statSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, statSync: statSyncMock };
});

import {
	mergeWindowsEnvironment,
	resetSafeSpawnWindowsCommandCache,
	resolveWindowsCommandForEnvironment,
} from "../../clients/safe-spawn.js";

function markFilesAsPresent(...files: string[]): void {
	const present = new Set(files);
	statSyncMock.mockImplementation((candidate: unknown) => {
		if (present.has(String(candidate))) return { isFile: () => true };
		throw new Error("ENOENT");
	});
}

describe("Windows command resolution against a child environment (#1199)", () => {
	beforeEach(() => {
		resetSafeSpawnWindowsCommandCache();
		statSyncMock.mockReset();
	});

	it("resolves the Knip managed-bin call shape from caller PATH, not ambient PATH", () => {
		const ambientBin = path.win32.join("ambient", "node_modules", ".bin");
		const managedBin = path.win32.join("managed", "node_modules", ".bin");
		const managedKnip = path.win32.join(managedBin, "knip.cmd");
		markFilesAsPresent(managedKnip);

		// This is the environment shape supplied by KnipClient: both Windows
		// spellings are present and the managed directory is first.
		const knipEnv = mergeWindowsEnvironment(
			{ PATH: ambientBin, Path: ambientBin, PATHEXT: ".EXE" },
			{ PATH: managedBin, Path: managedBin, PATHEXT: ".CMD;.EXE" },
		);
		const resolved = resolveWindowsCommandForEnvironment(
			"knip",
			path.win32.join("workspace", "project"),
			knipEnv,
		);

		expect(resolved).toEqual({ resolvedPath: managedKnip, ext: ".cmd" });
	});

	it("lets a caller PATH override every ambient PATH/Path casing and emits one key", () => {
		const ambient = { PATH: "ambient-path", Path: "ambient-duplicate" };
		const merged = mergeWindowsEnvironment(ambient, { pAtH: "caller-path" });
		const pathEntries = Object.entries(merged).filter(
			([key]) => key.toLowerCase() === "path",
		);

		expect(pathEntries).toEqual([["pAtH", "caller-path"]]);
	});

	it("reads PATH and PATHEXT case-insensitively", () => {
		const bin = path.win32.join("case-variant", "bin");
		const executable = path.win32.join(bin, "tool.cmd");
		markFilesAsPresent(executable);

		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, {
				pAtH: bin,
				pAtHeXt: ".CmD",
			}),
		).toEqual({ resolvedPath: executable, ext: ".cmd" });
	});

	it("does not reuse a cached result across PATH or PATHEXT changes", () => {
		const cmdBin = path.win32.join("first", "bin");
		const exeBin = path.win32.join("second", "bin");
		const cmdPath = path.win32.join(cmdBin, "cache-tool.cmd");
		const exePath = path.win32.join(exeBin, "cache-tool.exe");
		markFilesAsPresent(cmdPath, exePath);

		const first = resolveWindowsCommandForEnvironment("cache-tool", "cwd", {
			Path: cmdBin,
			PATHEXT: ".CMD",
		});
		const callsAfterFirst = statSyncMock.mock.calls.length;
		const second = resolveWindowsCommandForEnvironment("cache-tool", "cwd", {
			PATH: exeBin,
			PATHEXT: ".EXE",
		});
		const callsAfterSecond = statSyncMock.mock.calls.length;
		const secondAgain = resolveWindowsCommandForEnvironment("cache-tool", "cwd", {
			PATH: exeBin,
			PATHEXT: ".EXE",
		});

		expect(first).toEqual({ resolvedPath: cmdPath, ext: ".cmd" });
		expect(second).toEqual({ resolvedPath: exePath, ext: ".exe" });
		expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
		expect(secondAgain).toEqual(second);
		expect(statSyncMock.mock.calls.length).toBe(callsAfterSecond);
	});

	it("uses win32 parsing for explicit relative paths on every host OS", () => {
		const cwd = path.win32.join("workspace", "project");
		const relativeCommand = path.win32.join("tools", "tool.exe");
		const resolvedPath = path.win32.resolve(cwd, relativeCommand);
		markFilesAsPresent(resolvedPath);

		expect(
			resolveWindowsCommandForEnvironment(relativeCommand, cwd, {}),
		).toEqual({ resolvedPath, ext: ".exe" });
	});

	it("keeps the default PATHEXT behavior when the caller supplies no PATHEXT", () => {
		const bin = path.win32.join("default", "bin");
		const executable = path.win32.join(bin, "tool.exe");
		markFilesAsPresent(executable);

		expect(
			resolveWindowsCommandForEnvironment("tool", undefined, { PATH: bin }),
		).toEqual({ resolvedPath: executable, ext: ".exe" });
	});
});
