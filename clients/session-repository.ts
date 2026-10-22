/**
 * The project-local bin-directory layouts and their ancestor walk, moved out
 * of `clients/package-manager.ts` (which re-exports them) so the spawn seam
 * can import them: `package-manager.ts` spawns through `safe-spawn.ts`, so
 * the reverse edge would be a cycle (#4530).
 */

import * as os from "node:os";
import * as path from "node:path";
import { isAtOrAboveHomeDir, walkUpDirs } from "./path-utils.js";

/**
 * The project-local bin-directory shapes in this repo, most-preferred first.
 * Exported so every caller passes the SAME constant instead of re-listing the
 * directory names next to its own copy of the walk — the venv list alone had
 * three independent spellings before #2544 review F1 (`formatters.ts`,
 * `runner-helpers.ts`'s `createVenvFinder`, `dead-code-client.ts`'s
 * `venvCandidates`). `clients/package-manager.ts` re-exports them.
 *
 * `VENV_BIN_DIRS` lists BOTH the POSIX (`bin`) and Windows (`Scripts`) layouts
 * unconditionally rather than branching on `process.platform` at module load:
 * a module-load platform constant cannot be forced per test, so the other
 * branch is never exercised on the ubuntu lane (defect shape 30). The extra
 * two `existsSync` calls per directory are the price of a testable list, and
 * a `.venv/Scripts` on Linux (or `.venv/bin` under msys) resolves correctly
 * instead of being invisible.
 */
export const NODE_MODULES_BIN_DIRS: readonly string[] = [
	path.join("node_modules", ".bin"),
];
export const VENDOR_BIN_DIRS: readonly string[] = [path.join("vendor", "bin")];
export const VENV_BIN_DIRS: readonly string[] = [
	path.join(".venv", "bin"),
	path.join("venv", "bin"),
	path.join(".venv", "Scripts"),
	path.join("venv", "Scripts"),
];

/** Every project-local bin layout supported by the canonical resolver. */
export const PROJECT_LOCAL_BIN_DIRS: readonly string[] = [
	...NODE_MODULES_BIN_DIRS,
	...VENDOR_BIN_DIRS,
	...VENV_BIN_DIRS,
];

/** Every project-local bin dir of `dir` and of its ancestors below HOME. */
export function* projectLocalBinDirs(
	dir: string,
	home: string = os.homedir(),
): Generator<string> {
	for (const ancestor of walkUpDirs(dir)) {
		if (isAtOrAboveHomeDir(ancestor, home)) return;
		for (const binDir of PROJECT_LOCAL_BIN_DIRS)
			yield path.join(ancestor, binDir);
	}
}
