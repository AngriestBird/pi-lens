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
	" R", // #2060: worktree rename with a clean index (real git 2.55)
	" C", // #2060: worktree copy with a clean index
	"DR", // #2060: git's short-format table pairs index D with worktree R
	"DC", // #2060: ...and with worktree C
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

	// #2060 F2b: an XY pair outside the documented matrix is a gap in OUR
	// table, not proof the output is corrupt. Voiding the whole command's
	// recovery for one such entry silently re-opened the read-guard hole the
	// subsystem exists to close, so a well-formed entry keeps its path and is
	// counted instead.
	it.each([
		["mixed untracked", "?M"],
		["mixed ignored", "!A"],
		["undocumented unmerged index state", "U "],
		["undocumented unmerged worktree state", " U"],
		["staged deletion paired with worktree modification", "DM"],
		["staged deletion paired with worktree type change", "DT"],
		["undocumented ordinary state", "MR"],
	])(
		"retains %s status %j and counts it rather than voiding recovery",
		async (_label, status) => {
			// porcelainOutput, not a hand-built token: an R/C pair still owes a
			// second path token, and omitting it IS unparseable output.
			safeSpawnAsync.mockResolvedValue({
				status: 0,
				stdout: porcelainOutput([status]),
			});

			await expect(
				recoverOpaqueChangesViaGit("/repo", Date.now()),
			).resolves.toEqual({
				verdict: "recovered",
				paths: [],
				scannedCount: 0,
				unknownStatusCount: 1,
			});
		},
	);

	it.each([
		["blank status carrying no change at all", "  "],
		["status characters outside git's alphabet", "%%"],
		["a single non-status character", "1 "],
		// Softening the XY table must not soften the TOKEN grammar: an R/C pair
		// owes a second path token whether or not the pair is documented.
		["an undocumented rename pair missing its old-path token", "MR"],
	])("rejects %s (%j) as unparseable", async (_label, status) => {
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

	// #2060 F4: safe-spawn caps stdout before the child finishes. A capped
	// status listing is a PREFIX of the truth, so treating it as complete would
	// report "clean" for every path the cap removed.
	it("fails closed when safe-spawn truncated the status output", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: " M kept.ts\0",
			outputTruncated: true,
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

	// #2060: an undocumented pair is never classified as incoming, so widening
	// the table can only ever ADD exclusions, never remove capture by surprise.
	it("never treats an undocumented pair as clean incoming content", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: porcelainOutput(["UU", "U ", "A "]),
		});

		await expect(
			recoverOpaqueChangesViaGit("/repo", Date.now(), {
				excludeIndexOnlyWhenUnmerged: true,
			}),
		).resolves.toEqual({
			verdict: "recovered",
			paths: [],
			scannedCount: 0,
			// Only `A ` is dropped. `U ` is undocumented, so it keeps its path.
			excludedIncomingCount: 1,
			unknownStatusCount: 1,
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
