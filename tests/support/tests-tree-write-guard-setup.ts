import * as path from "node:path";

import {
	installTestsTreeWriteGuard,
	type TestsTreeWriteGuard,
} from "./tests-tree-write-guard.js";

/**
 * globalSetup arm of the #3082 guard — one watcher per RUN, not per fork, so
 * the cost is a single recursive inotify registration whatever the fork count.
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
