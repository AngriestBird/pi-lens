import { beforeEach, describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

import { recoverOpaqueChangesViaGit } from "../../clients/opaque-mutation-scan.js";

// Mirrors Git's documented Porcelain v1 ordinary matrix. Keep this explicit:
// a Cartesian product accepts impossible staged-deletion pairs such as DM/DT.
const ORDINARY_STATUSES = [
	" M",
	" T",
	" D",
	" A", // intent-to-add from `git add -N`
	"M ",
	"MM",
	"MT",
	"MD",
	"T ",
	"TM",
	"TT",
	"TD",
	"A ",
	"AM",
	"AT",
	"AD",
	"D ",
	"R ",
	"RM",
	"RT",
	"RD",
	"C ",
	"CM",
	"CT",
	"CD",
];

function porcelainOutput(statuses: string[]): string {
	return statuses
		.map((status, index) => {
			const path = `path-${index}.ts`;
			const oldPath =
				status.includes("R") || status.includes("C") ? `old-${path}\0` : "";
			return `${status} ${path}\0${oldPath}`;
		})
		.join("");
}

describe("opaque Git status parsing", () => {
	beforeEach(() => safeSpawnAsync.mockReset());

	it.each([
		["ordinary tracked states", ORDINARY_STATUSES],
		["untracked and ignored states", ["??", "!!"]],
		["documented unmerged states", ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]],
	])("accepts %s", async (_label, statuses) => {
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: porcelainOutput(statuses),
		});

		await expect(
			recoverOpaqueChangesViaGit("/repo", Date.now()),
		).resolves.toEqual({
			verdict: "recovered",
			paths: [],
			scannedCount: 0,
		});
	});

	it.each([
		["mixed untracked", "?M"],
		["mixed ignored", "!A"],
		["unsupported unmerged index state", "U "],
		["unsupported unmerged worktree state", " U"],
		["blank status", "  "],
		["staged deletion paired with worktree modification", "DM"],
		["staged deletion paired with worktree type change", "DT"],
		["unsupported ordinary state", "MR"],
	])("rejects %s status %j as unknown", async (_label, status) => {
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: `${status} malformed.ts\0`,
		});

		await expect(
			recoverOpaqueChangesViaGit("/repo", Date.now()),
		).resolves.toEqual({
			verdict: "unknown",
			paths: [],
			unknownReason: "git-status-parse-failed",
			scannedCount: 0,
		});
	});

	it("returns an explicit unknown verdict for unterminated porcelain output", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: " M incomplete.ts",
		});

		await expect(
			recoverOpaqueChangesViaGit("/repo", Date.now()),
		).resolves.toEqual({
			verdict: "unknown",
			paths: [],
			unknownReason: "git-status-parse-failed",
			scannedCount: 0,
		});
	});
});
