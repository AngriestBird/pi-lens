import * as path from "node:path";

import {
	installTestsTreeWriteGuard,
	type TestsTreeWriteGuard,
} from "./tests-tree-write-guard.js";

/**
 * Repo-root files a test is known to write and remove within one run,
 * excused from the root arm below (#3105).
 *
 * `tests/index-2992-integration.test.ts` writes `index-2992-probe.ts` and
 * `index-2992-recovered.ts` at the repo root, not under `tests/` and not
 * under a gitignored scratch dir: the read/mutation bridges it drives are
 * real, and `isRecordableProjectPath` (`clients/file-utils.ts`) treats any
 * path either outside the project root or matched by `.gitignore` as
 * external/vendor and silently drops it — so a mkdtemp root, the pinned
 * TMPDIR (outside the worktree), or the test's own `.probe-home` (gitignored,
 * used for `PI_LENS_HOME` two lines above each write) would all make the
 * bridges under test silently stop recording, which is the behavior the test
 * exists to exercise. The repo root is the one place that is simultaneously
 * "under the project root" and "not gitignored". Both files are removed
 * before the `it` that created them returns (`afterEach`/`finally`).
 */
const ROOT_WRITE_ALLOWLIST: ReadonlySet<string> = new Set([
	"index-2992-probe.ts",
	"index-2992-recovered.ts",
]);

/**
 * globalSetup arm of the #3082 guard — one watcher per activated PROJECT, not
 * one per test-file fork, so the cost is independent of the fork count.
 *
 * Measured, not assumed (#3104 review F3): vitest attaches this list to every
 * project (`vitest.config.ts`'s seven `globalSetup: sharedGlobalSetup` rows),
 * and runs the arm once per project that has matching files — a run touching
 * two projects invoked it twice, in ONE process, each time with its own module
 * instance (`moduleCount=1` both times). So a module-level "install once"
 * latch would be inert here, exactly AGENTS.md shape 25; only a
 * `process`-keyed singleton would deduplicate, and that buys one baseline walk
 * and ~300 inotify watches at the price of process-lifetime state plus an
 * assumption about which project's teardown runs first — the arm that owns the
 * report. Not taken: N watchers all observe the same events and the only
 * visible consequence is the report printing once per project instead of once.
 *
 * The teardown throws, which fails the vitest run: there is no `afterAll` at
 * run level to fail instead, and a warning would be exactly the silent
 * degradation the sweeps already guard against (AGENTS.md shape 10). The
 * message names the created path, which is what identified the producer in
 * #3082 within one line of log.
 *
 * Injectable `root` (and, defaulted from it, the guard itself) so
 * tests/support/tests-tree-write-guard.test.ts can drive this setup against a
 * controlled fixture tree instead of the live repo, the shape
 * tests/support/git-config-guard-setup.ts uses.
 */
export function runTestsTreeWriteGuardSetup(
	root: string,
	guard: TestsTreeWriteGuard = installTestsTreeWriteGuard(root),
): () => void {
	return () => {
		try {
			const report = guard.report();
			if (report) throw new Error(report);
		} finally {
			guard.close();
		}
	};
}

/**
 * Repo-root arm (#3105): the same producer shape as the `tests/` arm above —
 * a test creating a source file inside a tree it does not own, mid-run — but
 * one directory up, where no directory-walking sweep enumerates today. A
 * non-recursive watch (see {@link installTestsTreeWriteGuard}'s `recursive`
 * option): only a file appearing directly in the repo root is this shape; a
 * nested one is the `tests/` arm's to catch, or already the tracked tree's
 * business.
 */
function installRootWriteGuard(): TestsTreeWriteGuard {
	return installTestsTreeWriteGuard(process.cwd(), {
		recursive: false,
		allow: ROOT_WRITE_ALLOWLIST,
	});
}

/**
 * Combine any number of guards into one teardown: every report gets thrown
 * together (so a `tests/` violation and a root violation in the same run are
 * both visible, not just whichever guard's `report()` ran first), and every
 * guard is closed regardless of whether the combined teardown throws — the
 * same close-on-throw contract {@link runTestsTreeWriteGuardSetup} keeps for
 * one guard (AGENTS.md shape 4: a throw must never leak the watch handle).
 */
export function combineGuardTeardowns(
	guards: readonly TestsTreeWriteGuard[],
): () => void {
	return () => {
		try {
			const reports = guards
				.map((guard) => guard.report())
				.filter((report): report is string => report !== undefined);
			if (reports.length > 0) throw new Error(reports.join("\n\n"));
		} finally {
			for (const guard of guards) guard.close();
		}
	};
}

export default function setup(): () => void {
	const testsGuard = installTestsTreeWriteGuard(
		path.join(process.cwd(), "tests"),
	);
	const rootGuard = installRootWriteGuard();
	return combineGuardTeardowns([testsGuard, rootGuard]);
}
