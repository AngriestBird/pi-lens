import { defineConfig } from "vitest/config";

// Applies to globalSetup as well as workers: ordinary tests never install tools.
process.env.PI_LENS_DISABLE_TOOL_INSTALL ??= "1";

// Minimal config — vitest defaults (test discovery, pools, etc.) are preserved.
// Additions:
//  - globalSetup fails fast on a stale in-place build, so tests can't silently
//    run against pre-edit compiled `.js` (#198).
//  - worker heap headroom: the full suite occasionally died with a "Worker
//    exited unexpectedly" + a `node::GetNodeReport` dump. That report is emitted
//    by Node's OWN fatal-error handler (V8 heap-limit reached) — an external OS
//    OOM-kill SIGKILLs with no dump — so the crash is a single long-lived worker
//    hitting its own V8 heap ceiling, not system memory exhaustion (32-core /
//    68 GB host). With `isolate: true` vitest resets each worker's module
//    registry per file, so the native addons (the many tree-sitter grammars +
//    @ast-grep/napi) are re-loaded file-after-file and their off- and on-heap
//    buffers accumulate in the reused worker until a heavy worker tips over.
//    `execArgv` passes --max-old-space-size to every spawned worker, giving that
//    headroom WITHOUT capping worker count (no CI slowdown); aggregate risk is
//    negligible (workers never all peak at once, and 4 GB × workers ≪ host RAM).
//    Tune via PI_LENS_TEST_WORKER_HEAP_MB. NOTE: Vitest 4 flattened the config —
//    `execArgv` is a direct `test` field (the v3 `poolOptions.forks.execArgv`
//    nesting no longer exists and is silently ignored).
export default defineConfig({
	test: {
		// Background coding agents get worktrees under .claude/worktrees/ —
		// vitest's default exclude covers node_modules/.git/dist but NOT those,
		// so a "full suite" run in the main tree silently swept every agent's
		// IN-PROGRESS worktree tests too (seen 2026-07-11: 40+ phantom failures,
		// all from half-finished branches in sibling worktrees).
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.{git,cache,output,temp}/**",
			"**/.claude/**",
		],
		globalSetup: [
			"./tests/support/check-build-freshness.ts",
			"./tests/support/prewarm-grammars.ts",
			// After check-build-freshness: the seed analyze runs the in-place build.
			"./tests/support/prewarm-tool-home.ts",
		],
		setupFiles: ["./tests/support/vitest-setup.ts"],
		// Local runs: cap forks at half the cores (measured 2026-07-29 on a
		// 16-core host, post dead-wait removal: 8 forks ≈ 40s / 9-11 GB peak
		// RSS; 6 forks ≈ 44s / 8 GB; the old uncapped 15 forks gave the same
		// memory for a slower wall). CI keeps vitest's default — its 4-core
		// runner has no worker headroom to give back. Memory-constrained runs:
		// PI_LENS_TEST_MAX_WORKERS=6.
		maxWorkers: process.env.CI
			? undefined
			: Number(process.env.PI_LENS_TEST_MAX_WORKERS) || "50%",
		execArgv: [
			`--max-old-space-size=${process.env.PI_LENS_TEST_WORKER_HEAP_MB || 4096}`,
		],
	},
});
