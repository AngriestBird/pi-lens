import * as path from "node:path";

import {
	installTestsTreeWriteGuard,
	type TestsTreeWriteGuard,
} from "./tests-tree-write-guard.js";

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

export default function setup(): () => void {
	return runTestsTreeWriteGuardSetup(path.join(process.cwd(), "tests"));
}
