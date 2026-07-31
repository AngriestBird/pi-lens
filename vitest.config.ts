import { defineConfig } from "vitest/config";

// Applies to globalSetup as well as workers: ordinary tests never install tools.
process.env.PI_LENS_DISABLE_TOOL_INSTALL ??= "1";

// Background coding agents get worktrees under .claude/worktrees/ — vitest's
// default exclude covers node_modules/.git/dist but NOT those, so a "full
// suite" run in the main tree silently swept every agent's IN-PROGRESS
// worktree tests too (seen 2026-07-11: 40+ phantom failures, all from
// half-finished branches in sibling worktrees).
const sharedExclude = [
	"**/node_modules/**",
	"**/dist/**",
	"**/.{git,cache,output,temp}/**",
	"**/.claude/**",
];

const sharedGlobalSetup = [
	"./tests/support/check-build-freshness.ts",
	"./tests/support/prewarm-grammars.ts",
	// After check-build-freshness: the seed analyze runs the in-place build.
	"./tests/support/prewarm-tool-home.ts",
];

const sharedSetupFiles = ["./tests/support/vitest-setup.ts"];

// Local runs: cap forks at half the cores (measured 2026-07-29 on a
// 16-core host, post dead-wait removal: 8 forks ≈ 40s / 9-11 GB peak
// RSS; 6 forks ≈ 44s / 8 GB; the old uncapped 15 forks gave the same
// memory for a slower wall). CI keeps vitest's default — its 4-core
// runner has no worker headroom to give back. Memory-constrained runs:
// PI_LENS_TEST_MAX_WORKERS=6.
const sharedMaxWorkers = process.env.CI
	? undefined
	: Number(process.env.PI_LENS_TEST_MAX_WORKERS) || "50%";

// Worker heap headroom: the full suite occasionally died with a "Worker
// exited unexpectedly" + a `node::GetNodeReport` dump. That report is emitted
// by Node's OWN fatal-error handler (V8 heap-limit reached) — an external OS
// OOM-kill SIGKILLs with no dump — so the crash is a single long-lived worker
// hitting its own V8 heap ceiling, not system memory exhaustion (32-core /
// 68 GB host). With `isolate: true` (vitest's default) each worker's module
// registry is reset per file, so the native addons (the many tree-sitter
// grammars + @ast-grep/napi) are re-loaded file-after-file and their off- and
// on-heap buffers accumulate in the reused worker until a heavy worker tips
// over. `execArgv` passes --max-old-space-size to every spawned worker,
// giving that headroom WITHOUT capping worker count (no CI slowdown);
// aggregate risk is negligible (workers never all peak at once, and 4 GB ×
// workers ≪ host RAM). Tune via PI_LENS_TEST_WORKER_HEAP_MB. NOTE: Vitest 4
// flattened the config — `execArgv` is a direct `test` field (the v3
// `poolOptions.forks.execArgv` nesting no longer exists and is silently
// ignored).
const sharedExecArgv = [
	`--max-old-space-size=${process.env.PI_LENS_TEST_WORKER_HEAP_MB || 4096}`,
];

// Tier 1 fix (#902): these files all transitively drive real tree-sitter
// grammar parses (via clients/review-graph/builder.js or the project-diagnostics
// scanner), and `isolate: true` (required — see above, and removing it
// reintroduces the V8 heap-ceiling crash) means each test FILE gets a fresh
// module registry, so the native grammar addons get re-loaded/re-compiled
// per file rather than once per worker. Grammar prewarm
// (tests/support/prewarm-grammars.ts) only pre-fetches the wasm BYTES to
// disk — it does nothing to stop several of these files re-compiling their
// grammars concurrently once spread across forks under the default
// `maxWorkers: "50%"`. That contention was intermittently blowing past the
// fork teardown deadline ("Timeout terminating forks worker") even though
// every test in the file had already passed. Carving this glob into its own
// project with a small capped `maxWorkers` bounds how many of these heavy
// files compile grammars at once, without reducing parallelism for the rest
// of the suite (which keeps its existing `maxWorkers: "50%"` in the
// "default" project below).
const grammarHeavyInclude = [
	"tests/clients/review-graph/shared-extraction-ir.test.ts",
	"tests/clients/review-graph/tsconfig-paths.test.ts",
	"tests/clients/review-graph/extract-symbols.test.ts",
	"tests/clients/project-diagnostics/scanner.test.ts",
];

export default defineConfig({
	test: {
		exclude: sharedExclude,
		// Root-config-only in Vitest 4 (see the grammar-heavy project's comment
		// below) — applies to every project's fork teardown, not just the
		// grammar-heavy one, which is strictly more forgiving everywhere else.
		teardownTimeout: 30_000,
		projects: [
			{
				test: {
					name: "default",
					exclude: [...sharedExclude, ...grammarHeavyInclude],
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					maxWorkers: sharedMaxWorkers,
					execArgv: sharedExecArgv,
					// Vitest 4 requires distinct groupOrder whenever projects have
					// different `maxWorkers` — see the "grammar-heavy" project below
					// for why that's actually desirable here, not just a workaround.
					sequence: { groupOrder: 0 },
				},
			},
			{
				test: {
					name: "grammar-heavy",
					include: grammarHeavyInclude,
					exclude: sharedExclude,
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					execArgv: sharedExecArgv,
					// Cap, don't serialize: bounds concurrent grammar re-compiles to
					// 2-at-a-time instead of whatever `maxWorkers: "50%"` would give
					// them (the root cause above), without going fully sequential.
					// NOTE: Vitest 4 removed `poolOptions.forks.maxForks` — pool
					// concurrency knobs were unified into the top-level
					// `maxWorkers` (applies to whichever pool is active; this repo
					// uses the default `forks` pool everywhere).
					maxWorkers: 2,
					// Distinct groupOrder is required whenever projects have
					// different `maxWorkers` (Vitest 4 throws otherwise). Side
					// effect: scheduling groups run as sequential PHASES (group 0
					// fully drains, then group 1 starts) rather than interleaved —
					// a feature here, not a cost: it guarantees these 4
					// grammar-heavy files never share fork-scheduling time with the
					// rest of the suite, so they can never race a batch of OTHER
					// files' concurrent grammar compiles either.
					sequence: { groupOrder: 1 },
					// Supplement, not a substitute for the maxForks cap above: give
					// fork teardown more headroom in case a heavy grammar compile is
					// still finishing when a test file's hooks wrap up.
					// NOTE: Vitest 4's per-project `ProjectConfig` type excludes
					// `teardownTimeout` (it moved to root-config-only), so the 30s
					// bump lives on the top-level `test` block below instead —
					// applies to both projects, which only makes the default
					// project's teardown MORE forgiving, never less.
					hookTimeout: 60_000,
				},
			},
		],
	},
});
