/**
 * #1790: `sweepInlineBlockerFreshness`'s population was built solely from
 * `RuntimeCoordinator`'s inline-blocker map — a live-dispatch-only store. A
 * workspace-diagnostics CACHE HIT never touches that map; it writes straight into
 * `widget-state.ts`'s `files` store (the cache-serve branch of
 * `tools/lsp-diagnostics.ts` calling `reconcileScanDiagnostics`). During the
 * 2026-08-20 dogfood the turn-end sweep logged `total:1 kept:1` while five stale
 * cache-served blocking rows rendered in the widget — the sweep's population never
 * saw them, so its drift check never ran over them either.
 *
 * These tests exercise the fix at the same call shape `runtime-turn.ts` uses:
 * `sweepInlineBlockerFreshness(runtime, cwd, { additionalEntries })`, where
 * `additionalEntries` comes from `widget-state.ts`'s `getWidgetBlockingFilesForSweep`
 * and each entry's `demote` is `markWidgetFileBlockersStale`. Red-first: on pre-fix
 * code `additionalEntries` does not exist on `BlockerFreshnessOptions`, so a
 * cache-served-only row is invisible to `total`/`kept`/`revalidated` and the widget
 * store's `stale` flag is never set by the sweep.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepInlineBlockerFreshness } from "../../clients/blocker-freshness.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	clearWidgetState,
	getFileDiagnostics,
	getWidgetBlockingFilesForSweep,
	isBlocking,
	markWidgetFileBlockersStale,
	recordDiagnostics,
} from "../../clients/widget-state.js";

const tempDirs: string[] = [];
function makeDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	clearWidgetState();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function driftIntoFuture(filePath: string): void {
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(filePath, future, future);
}

function pushIntoPast(filePath: string): void {
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(filePath, past, past);
}

/** Simulates a workspace-diagnostics CACHE-HIT replay: `recordDiagnostics` with an
 * `observedAt` in the past, exactly as `tools/lsp-diagnostics.ts`'s cache-serve
 * branch passes the cache entry's own `scannedAt` — never touching
 * `RuntimeCoordinator`'s inline-blocker map. */
function recordCacheServedBlocking(
	filePath: string,
	message: string,
	observedAt: number,
): void {
	recordDiagnostics(
		filePath,
		[
			{
				severity: "error",
				semantic: "blocking",
				message,
				tool: "lsp",
				rule: "ts(2305)",
				line: 1,
			},
		],
		1,
		observedAt,
	);
}

/** Builds the same `additionalEntries` shape `runtime-turn.ts` passes. */
function widgetAdditionalEntries() {
	return getWidgetBlockingFilesForSweep().map((row) => ({
		filePath: row.filePath,
		recordedAtMs: row.recordedAtMs,
		demote: () => markWidgetFileBlockersStale(row.filePath, "dependency-drift"),
	}));
}

describe("blocker freshness sweep — widget-store population (#1790)", () => {
	it("counts a cache-served-only blocking row in the sweep's population", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-count-");
		const consumer = path.join(dir, "consumer.ts");
		fs.writeFileSync(consumer, "export const y = 1;\n");

		// No RuntimeCoordinator.recordInlineBlockers call at all — this row only
		// exists because a cache hit replayed it into the widget store.
		recordCacheServedBlocking(consumer, "cached blocking finding", Date.now());

		const runtime = new RuntimeCoordinator();
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);

		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		expect(counts.total).toBe(1);
		expect(counts.kept).toBe(1);
	});

	it("demotes a cache-served-only blocking row whose dependency drifted out-of-band", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-demote-");
		const consumer = path.join(dir, "git-env.test.ts");
		const dep = path.join(dir, "worktree.ts");
		fs.writeFileSync(dep, "export const other = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { gitEnv } from "./worktree.js";\nexport const t = gitEnv;\n',
		);

		// Verdict observed 60s ago, replayed from cache — the dependency's real fix
		// (or, per #1782/#1786, the cache simply outliving its own validity) lands
		// after that.
		recordCacheServedBlocking(consumer, "No exported member 'gitEnv'", Date.now() - 60_000);
		expect((getFileDiagnostics(consumer) ?? []).some((d) => isBlocking(d))).toBe(true);

		driftIntoFuture(dep);

		const runtime = new RuntimeCoordinator();
		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		expect(counts.total).toBe(1);
		expect(counts.revalidated).toBe(1);
		expect(counts.kept).toBe(0);

		// Demoted, not dropped: the widget row survives but is no longer blocking.
		const diags = getFileDiagnostics(consumer) ?? [];
		expect(diags).toHaveLength(1);
		expect(diags.some((d) => d.stale === true)).toBe(true);
		expect(diags.some((d) => isBlocking(d))).toBe(false);
	});

	it("keeps a cache-served-only blocking row whose dependency did not drift", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-keep-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);
		pushIntoPast(dep);

		recordCacheServedBlocking(consumer, "cached blocking finding", Date.now());

		const runtime = new RuntimeCoordinator();
		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		expect(counts.total).toBe(1);
		expect(counts.kept).toBe(1);
		expect(counts.revalidated).toBe(0);
		expect((getFileDiagnostics(consumer) ?? []).some((d) => isBlocking(d))).toBe(true);
	});

	it("processes a file present in BOTH stores exactly once (no duplicate gate run)", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-dedup-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers(consumer, "🔴 live blocker", 1, ["lsp"]);
		// A stale widget-store remnant for the SAME file (e.g. a prior cache reply).
		recordCacheServedBlocking(consumer, "cached blocking finding", Date.now());

		driftIntoFuture(dep);

		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: widgetAdditionalEntries(),
		});
		// One population: the file counted once (via its inline-blocker entry), not
		// twice just because it also has a widget-store row.
		expect(counts.total).toBe(1);
		expect(counts.revalidated).toBe(1);
	});

	it("bounds the added cost to the widget store's own currently-blocking files", async () => {
		const dir = makeDir("pi-lens-fresh-widgetpop-bound-");
		const files: string[] = [];
		for (let i = 0; i < 5; i++) {
			const f = path.join(dir, `consumer${i}.ts`);
			fs.writeFileSync(f, "export const y = 1;\n");
			recordCacheServedBlocking(f, `cached blocking finding ${i}`, Date.now());
			files.push(f);
		}
		// A clean (non-blocking) widget row must not inflate the population.
		const clean = path.join(dir, "clean.ts");
		fs.writeFileSync(clean, "export const z = 1;\n");
		recordDiagnostics(clean, [], 1, Date.now());

		const runtime = new RuntimeCoordinator();
		const entries = widgetAdditionalEntries();
		expect(entries).toHaveLength(5);
		expect(entries.map((e) => e.filePath).sort()).toEqual([...files].sort());

		const counts = await sweepInlineBlockerFreshness(runtime, dir, {
			additionalEntries: entries,
		});
		expect(counts.total).toBe(5);
	});
});
