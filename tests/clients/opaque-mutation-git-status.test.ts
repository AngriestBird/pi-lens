import { beforeEach, describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

import { recoverOpaqueChangesViaGit } from "../../clients/opaque-mutation-scan.js";

describe("opaque Git status parsing", () => {
	beforeEach(() => safeSpawnAsync.mockReset());

	it("returns an explicit unknown verdict for malformed porcelain output", async () => {
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
