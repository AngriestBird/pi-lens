/**
 * Tests for clients/atomic-write.ts (#762) — the shared tmp+rename atomic
 * writer that replaces the five hand-rolled `${target}.tmp-${pid}` +
 * `renameSync`/`rename` writers (instance-registry.ts, session-state-store.ts,
 * recent-touches.ts, review-graph/builder.ts, diagnostic-dispositions.ts).
 *
 * Covers the sync (`writeFileAtomic`) and async (`writeFileAtomicAsync`)
 * variants: success replaces content atomically, no tmp file is left behind
 * on success or on a swallowed failure, `bestEffort: true` (default) swallows
 * a rename failure, and `bestEffort: false` rethrows it (the #757
 * diagnostic-dispositions policy) after the same best-effort tmp cleanup.
 *
 * Rename failures are induced with a REAL filesystem obstruction (renaming a
 * file onto an existing non-empty directory), not a mocked `fs` — this repo's
 * `atomic-write.ts` uses `import * as fs from "node:fs"`, and Node's builtin
 * module namespace bindings don't reliably re-bind under `vi.spyOn` here, so
 * a genuine EPERM/ENOTEMPTY/EISDIR exercises the real failure path end to end
 * on every platform (verified: renaming onto a non-empty dir fails with EPERM
 * on Windows, ENOTEMPTY/EISDIR on POSIX).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	STAGE_TMP_PATTERN,
	stagePathFor,
	writeFileAtomic,
	writeFileAtomicAsync,
} from "../../clients/atomic-write.js";
import { removeTempDirSync } from "./test-utils.js";

let dir: string;

function tmpLeftovers(): string[] {
	return fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

/** A target path that already exists as a non-empty directory: renaming a
 * file onto it reliably fails on every platform. */
function makeUnrenamableTarget(): string {
	const target = path.join(dir, "state.json");
	fs.mkdirSync(target);
	fs.writeFileSync(path.join(target, "keep.txt"), "occupied");
	return target;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-atomic-write-"));
});

afterEach(() => {
	removeTempDirSync(dir);
});

describe("writeFileAtomic (sync)", () => {
	it("replaces the target's content atomically on success", () => {
		const target = path.join(dir, "state.json");
		fs.writeFileSync(target, "old");
		writeFileAtomic(target, "new");
		expect(fs.readFileSync(target, "utf-8")).toBe("new");
	});

	it("creates the target when it doesn't exist yet", () => {
		const target = path.join(dir, "state.json");
		writeFileAtomic(target, "hello");
		expect(fs.readFileSync(target, "utf-8")).toBe("hello");
	});

	it("leaves no tmp-<pid> file behind on success", () => {
		const target = path.join(dir, "state.json");
		writeFileAtomic(target, "hello");
		expect(tmpLeftovers()).toEqual([]);
	});

	it("leaves no tmp-<pid> file behind when the rename fails (bestEffort)", () => {
		const target = makeUnrenamableTarget();
		expect(() => writeFileAtomic(target, "hello")).not.toThrow();
		expect(tmpLeftovers()).toEqual([]);
		// The obstruction directory is untouched — only the tmp file was cleaned up.
		expect(fs.readdirSync(target)).toEqual(["keep.txt"]);
	});

	it("bestEffort: true (default) swallows a rename failure", () => {
		const target = makeUnrenamableTarget();
		expect(() => writeFileAtomic(target, "hello")).not.toThrow();
	});

	it("bestEffort: false rethrows a rename failure after best-effort cleanup", () => {
		const target = makeUnrenamableTarget();
		expect(() =>
			writeFileAtomic(target, "hello", { bestEffort: false }),
		).toThrow();
		expect(tmpLeftovers()).toEqual([]);
	});

	it("bestEffort: false lets a successful write/rename through untouched", () => {
		const target = path.join(dir, "state.json");
		writeFileAtomic(target, "hello", { bestEffort: false });
		expect(fs.readFileSync(target, "utf-8")).toBe("hello");
		expect(tmpLeftovers()).toEqual([]);
	});
});

describe("writeFileAtomicAsync", () => {
	it("replaces the target's content atomically on success", async () => {
		const target = path.join(dir, "state.json");
		fs.writeFileSync(target, "old");
		await writeFileAtomicAsync(target, "new");
		expect(fs.readFileSync(target, "utf-8")).toBe("new");
	});

	it("leaves no tmp-<pid> file behind on success", async () => {
		const target = path.join(dir, "state.json");
		await writeFileAtomicAsync(target, "hello");
		expect(tmpLeftovers()).toEqual([]);
	});

	it("bestEffort: true (default) swallows a rename failure and leaves no tmp file", async () => {
		const target = makeUnrenamableTarget();
		await expect(
			writeFileAtomicAsync(target, "hello"),
		).resolves.toBeUndefined();
		expect(tmpLeftovers()).toEqual([]);
		expect(fs.readdirSync(target)).toEqual(["keep.txt"]);
	});

	it("bestEffort: false rethrows a rename failure after best-effort cleanup", async () => {
		const target = makeUnrenamableTarget();
		await expect(
			writeFileAtomicAsync(target, "hello", { bestEffort: false }),
		).rejects.toThrow();
		expect(tmpLeftovers()).toEqual([]);
	});
});

/**
 * #1205 regression: the staging file used to be named `${target}.tmp-${pid}` —
 * per-PROCESS, not per-CALL. Two concurrent writes from one process to one
 * target therefore shared a staging inode: both `open(O_TRUNC)`ed it, the
 * first `rename` published that inode to the target, and the second writer's
 * still-open fd kept writing into the now-PUBLISHED file. The result was a
 * torn hybrid at the target path.
 *
 * Two independent assertions, so this has teeth on every OS rather than only
 * where the interleaving happens to be observable:
 *
 *  1. STRUCTURAL — deterministic on every platform, no scheduler race to win:
 *     two concurrent writes must use DISTINCT staging paths on the real
 *     filesystem (observed via the `path` on the rename error, which is the
 *     staging file the writer actually created), and `stagePathFor` must never
 *     repeat a name. Pre-fix both collapse to the single `.tmp-<pid>` name.
 *  2. BEHAVIOURAL: the published file must be byte-exactly one of the two
 *     payloads, never a hybrid. Mismatched payload sizes (2 MB vs 50 KB) make
 *     a hybrid trivially detectable. This is the assertion that was observed
 *     failing 35/40 on Windows in the issue report (13/40 when re-measured
 *     while developing this test). Whether the interleaving is *observable*
 *     is timing- and OS-dependent, which is exactly why assertion 1 exists.
 *
 * Nothing here branches on `process.platform`; the filesystem is probed
 * directly (recurring defect shape 2/7 — dev is Windows, CI is Linux).
 */
describe("concurrent same-process writes to one target (#1205)", () => {
	const ITERATIONS = 40;
	// Mismatched sizes: a hybrid is detectable by length alone, and a 2 MB
	// payload is large enough that Node's writeFile issues multiple chunked
	// writes, widening the interleaving window on every platform.
	const BIG = "A".repeat(2 * 1024 * 1024);
	const SMALL = "B".repeat(50 * 1024);

	/** Byte-exact identity against one of the two payloads, with a cheap
	 * failure message (never dump 2 MB into the diff). */
	function describePublished(published: string): string {
		if (published === BIG) return "BIG";
		if (published === SMALL) return "SMALL";
		return `HYBRID(len=${published.length}, A=${
			published.split("A").length - 1
		}, B=${published.split("B").length - 1})`;
	}

	it("async vs async: publishes exactly one payload, never a hybrid", async () => {
		const outcomes: string[] = [];
		for (let i = 0; i < ITERATIONS; i++) {
			const target = path.join(dir, `race-async-${i}.json`);
			// Alternate launch order so neither writer is systematically first.
			const [first, second] = i % 2 === 0 ? [BIG, SMALL] : [SMALL, BIG];
			await Promise.all([
				writeFileAtomicAsync(target, first),
				writeFileAtomicAsync(target, second),
			]);
			outcomes.push(describePublished(fs.readFileSync(target, "utf-8")));
		}
		expect(outcomes.filter((o) => o.startsWith("HYBRID"))).toEqual([]);
	});

	it("sync vs in-flight async: publishes exactly one payload, never a hybrid", async () => {
		const outcomes: string[] = [];
		for (let i = 0; i < ITERATIONS; i++) {
			const target = path.join(dir, `race-sync-${i}.json`);
			const pending = writeFileAtomicAsync(target, BIG);
			writeFileAtomic(target, SMALL);
			await pending;
			outcomes.push(describePublished(fs.readFileSync(target, "utf-8")));
		}
		expect(outcomes.filter((o) => o.startsWith("HYBRID"))).toEqual([]);
	});

	/**
	 * Deterministic structural guard — no scheduler race required, so this
	 * fires identically on Windows and on Linux CI.
	 *
	 * `bestEffort: false` against a target obstructed by a non-empty directory
	 * makes the rename fail, and Node populates `err.path` with the staging
	 * file the writer actually created on disk. Two concurrent writers must
	 * report two different staging paths; pre-fix they report the same one,
	 * which IS the shared-inode condition that produces the torn publish.
	 */
	it("concurrent writers create distinct staging files on disk", async () => {
		const target = makeUnrenamableTarget();
		const stagePaths = await Promise.all(
			[BIG, SMALL].map(async (payload) => {
				try {
					await writeFileAtomicAsync(target, payload, { bestEffort: false });
				} catch (err) {
					return (err as NodeJS.ErrnoException).path;
				}
				throw new Error("expected the rename onto a non-empty dir to fail");
			}),
		);
		expect(stagePaths.every((p) => typeof p === "string")).toBe(true);
		expect(new Set(stagePaths).size).toBe(2);
		for (const p of stagePaths) {
			expect(STAGE_TMP_PATTERN.test(p as string)).toBe(true);
		}
	});

	it("leaves no staging files behind after concurrent writes", async () => {
		const target = path.join(dir, "state.json");
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				writeFileAtomicAsync(target, i % 2 === 0 ? BIG : SMALL),
			),
		);
		expect(tmpLeftovers()).toEqual([]);
	});
});

describe("stagePathFor (#1205)", () => {
	it("returns a distinct path on every call for the same target", () => {
		const target = path.join(dir, "state.json");
		const paths = Array.from({ length: 100 }, () => stagePathFor(target));
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("keeps the target as a prefix and carries this process's pid", () => {
		const target = path.join(dir, "state.json");
		const staged = stagePathFor(target);
		expect(staged.startsWith(`${target}.tmp-${process.pid}-`)).toBe(true);
	});

	it("STAGE_TMP_PATTERN matches the names stagePathFor produces", () => {
		const staged = path.basename(stagePathFor(path.join(dir, "state.json")));
		expect(STAGE_TMP_PATTERN.test(staged)).toBe(true);
	});

	it("STAGE_TMP_PATTERN still matches pre-#1205 `.tmp-<pid>` leftovers", () => {
		// Sweepers must keep collecting staging files written by an older build
		// that is still on disk.
		expect(STAGE_TMP_PATTERN.test("review-graph.json.gz.tmp-4242")).toBe(true);
	});

	it("STAGE_TMP_PATTERN does not match ordinary store files", () => {
		for (const name of [
			"review-graph.json.gz",
			"state.json",
			"project-snapshot.json.gz.stage-4242-7",
		]) {
			expect(STAGE_TMP_PATTERN.test(name)).toBe(false);
		}
	});
});
