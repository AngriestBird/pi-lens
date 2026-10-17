/**
 * #4596: a declaration walk that could not read a subtree must say so, and
 * must never report a file under it as deleted.
 *
 * The defect the audit proved (probe 2). `walkDeclarations` skipped a
 * directory it could not list (`catch { continue; }`,
 * `clients/out-of-band-changes.ts`), the map it returned looked complete, and
 * the diff against the previous walk read every declaration file under that
 * directory as gone: `lsp_out_of_band_change` published `deleted: 1` for a
 * file that still existed, and a diagnostics cache refused entries for it. No
 * row named the failed read. AGENTS.md shape 10 ("silencing as fixing"): an
 * unavailable read is not a clean answer, and here it was not even silent — it
 * was a false event.
 *
 * Cells, written before the fix:
 *
 * | Cell | Walk | Published change | Record |
 * |---|---|---|---|
 * | control: a declaration edited under a readable directory | complete | `changed: 1` | no unreadable row |
 * | failure: the same edit under an unreadable directory | incomplete (1 dir) | nothing (no invented deletion) | one `lsp-declaration-walk-unreadable` row naming the root, the directory and the kept fingerprint |
 * | recovery: that subtree is readable again | complete | the real `changed: 1` | the same row from the earlier look |
 * | recovery: a file in it was really deleted while unreadable | complete, after | `deleted: 1`, once the walk can see it | a row per unreadable look |
 *
 * The unreadable directory is injected at the filesystem seam
 * (`fs.promises.readdir` refuses one path and every other read goes through
 * the real call), so the cell runs on every platform and needs no privileges;
 * the control cell in the same file proves the injection is the only
 * difference.
 */
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	type DiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import { getRecentLoggedPhases } from "../../clients/latency-logger.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import { normalizeMapKey } from "../../clients/path-utils.js";

let root: string;
const cleanups: Array<() => void> = [];
const previousInterval = process.env.PI_LENS_DECLARATION_LOOK_MS;

/** Refuse exactly one directory's listing; every other read stays real. */
function denyListing(dir: string): void {
	const real = fsp.readdir;
	const patched = (async (
		target: fs.PathLike,
		options?: unknown,
	): Promise<unknown> => {
		if (normalizeMapKey(String(target)) === normalizeMapKey(dir))
			throw Object.assign(new Error(`EACCES: permission denied, ${dir}`), {
				code: "EACCES",
			});
		// oxlint-disable-next-line typescript/no-explicit-any
		return (real as any)(target, options);
	}) as typeof fsp.readdir;
	fsp.readdir = patched;
	cleanups.push(() => {
		fsp.readdir = real;
	});
}

function recordPublishes(): DiskChange[] {
	const seen: DiskChange[] = [];
	cleanups.push(
		subscribeDiskChange("t4596-observes-publish", (change) => {
			seen.push(change);
		}),
	);
	return seen;
}

function unreadableRows(): Array<{
	kind: string;
	count: number;
	latestReasons: Array<{ subject: string; reason: string }>;
}> {
	return getDegradationSummary().filter(
		(group) => group.kind === "lsp-declaration-walk-unreadable",
	);
}

/** The `lsp_out_of_band_change` rows the detector wrote, newest first. */
function changeRows(): Array<Record<string, unknown>> {
	return getRecentLoggedPhases()
		.filter((entry) => entry.phase === "lsp_out_of_band_change")
		.map((entry) => entry.metadata ?? {});
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4596-walk-"));
	fs.mkdirSync(path.join(root, "types"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "types", "globals.d.ts"),
		"declare const A: number;\n",
	);
	// Every look walks: the cells below change the disk between two looks.
	process.env.PI_LENS_DECLARATION_LOOK_MS = "0";
	resetDegradationLedger();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	if (previousInterval === undefined)
		process.env.PI_LENS_DECLARATION_LOOK_MS = undefined;
	else process.env.PI_LENS_DECLARATION_LOOK_MS = previousInterval;
	fs.rmSync(root, { recursive: true, force: true });
});

describe("a declaration walk that could not read a subtree", () => {
	it("reports a changed declaration under a readable directory (control)", async () => {
		await lookForOutOfBandChanges(root, "tool_result");
		fs.writeFileSync(
			path.join(root, "types", "globals.d.ts"),
			"declare const A: string;\n",
		);
		const seen = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");

		expect(seen).toHaveLength(1);
		expect(seen[0].pathChanges).toEqual([
			{
				filePath: path.join(root, "types", "globals.d.ts"),
				type: "changed",
			},
		]);
		expect(changeRows()[0]).toMatchObject({ changed: 1, deleted: 0 });
		expect(unreadableRows()).toEqual([]);
	});

	it("records the unreadable subtree and publishes no deletion for it", async () => {
		const types = path.join(root, "types");
		await lookForOutOfBandChanges(root, "tool_result");
		fs.writeFileSync(
			path.join(types, "globals.d.ts"),
			"declare const A: string;\n",
		);

		denyListing(types);
		const seen = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");

		// The pre-fix detector published `deleted: 1` for a file that exists.
		expect(seen).toEqual([]);
		expect(changeRows()[0] ?? { deleted: 0 }).toMatchObject({ deleted: 0 });
		const rows = unreadableRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(1);
		// The record keeps the identity a reader needs: which root, which
		// directory, and how many fingerprints were kept instead of deleted.
		expect(rows[0].latestReasons[0].subject).toBe(normalizeMapKey(root));
		expect(rows[0].latestReasons[0].reason).toContain(types);
		expect(rows[0].latestReasons[0].reason).toContain("1 declaration file(s)");
	});

	it("reports the deferred change on the first walk that can read the subtree", async () => {
		const types = path.join(root, "types");
		await lookForOutOfBandChanges(root, "tool_result");
		fs.writeFileSync(
			path.join(types, "globals.d.ts"),
			"declare const A: string;\n",
		);

		denyListing(types);
		await lookForOutOfBandChanges(root, "tool_result");
		// The subtree is readable again: the carried fingerprint is compared
		// against the bytes the walk can finally see.
		for (const cleanup of cleanups.splice(0)) cleanup();
		const seen = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");

		expect(seen).toHaveLength(1);
		expect(seen[0].pathChanges).toEqual([
			{
				filePath: path.join(types, "globals.d.ts"),
				type: "changed",
			},
		]);
	});

	it("reports a real deletion under the subtree once it is readable again", async () => {
		const types = path.join(root, "types");
		await lookForOutOfBandChanges(root, "tool_result");

		denyListing(types);
		fs.rmSync(path.join(types, "globals.d.ts"));
		await lookForOutOfBandChanges(root, "tool_result");
		for (const cleanup of cleanups.splice(0)) cleanup();
		const seen = recordPublishes();
		await lookForOutOfBandChanges(root, "tool_result");

		expect(seen).toHaveLength(1);
		expect(seen[0].pathChanges).toEqual([
			{ filePath: path.join(types, "globals.d.ts"), type: "deleted" },
		]);
		expect(changeRows()[0]).toMatchObject({ deleted: 1 });
	});
});
