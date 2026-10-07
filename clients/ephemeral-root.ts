import * as os from "node:os";
import * as path from "node:path";
import { BoundedFifoMap } from "./bounded-cache.js";
import {
	isRealGitMarker,
	isUnderDir,
	normalizeEphemeralMapKey,
} from "./path-utils.js";
import { canonicalDirectory } from "./review-graph/git-identity.js";

/**
 * Where a directory sits relative to the host temporary directory (#1129).
 * `checkout` and `stagingRoot` are only ever set for a directory below the
 * real tmpdir, and never both: a real git checkout always wins over staging.
 */
interface TmpDirClass {
	/** A real git marker sits at or above the directory, below the tmpdir. */
	checkout: boolean;
	/** No checkout, and a `pi-agent-*` segment below the tmpdir: its real path. */
	stagingRoot?: string;
}

const NOT_EPHEMERAL: TmpDirClass = { checkout: false };

// One entry per directory spelling a process classifies; FIFO-evicted, so a
// long session's LSP traffic cannot grow it. The answer is settled for the
// process like the data dir it selects (#1129 F6): a later `git init` in a
// classified directory does not move that directory's data mid-process.
const classified = new BoundedFifoMap<string, TmpDirClass>(1024);

/**
 * One upward walk from `realpath(dir)` to `realpath(os.tmpdir())`, both sides
 * canonical through `realpathSync.native` (#1129 F4: macOS `/var` links to
 * `/private/var`, and Windows can report an 8.3 short tmpdir name). The first
 * real git marker (`isRealGitMarker`: a `.git` directory holding HEAD, or a
 * `gitdir:` file) makes the directory part of a temporary checkout, whatever
 * depth it sits at (F7). Without one, a `pi-agent-*` segment below the tmpdir
 * makes it host staging (F5).
 */
function classifyTmpDir(dir: string): TmpDirClass {
	const tmpSpelling = os.tmpdir();
	const key = `${normalizeEphemeralMapKey(tmpSpelling)}\0${normalizeEphemeralMapKey(path.resolve(dir))}`;
	const memo = classified.get(key);
	if (memo) return memo;
	const tmpRoot = canonicalDirectory(path.resolve(tmpSpelling));
	const real = canonicalDirectory(path.resolve(dir));
	let result = NOT_EPHEMERAL;
	if (isUnderDir(real, tmpRoot)) {
		for (let current = real; ; current = path.dirname(current)) {
			if (isRealGitMarker(path.join(current, ".git"))) {
				result = { checkout: true };
				break;
			}
			if (current === tmpRoot || path.dirname(current) === current) break;
		}
		if (!result.checkout) {
			const segments = path.relative(tmpRoot, real).split(path.sep);
			const index = segments.findIndex((segment) =>
				/^pi-agent(?:-|$)/i.test(segment),
			);
			if (index >= 0) {
				result = {
					checkout: false,
					stagingRoot: path.join(tmpRoot, ...segments.slice(0, index + 1)),
				};
			}
		}
	}
	classified.set(key, result);
	return result;
}

/**
 * The host-created `pi-agent-*` staging directory that holds `filePath`, as a
 * real path, or `undefined`. Staging dirs are tool-internal, never a user
 * project; a real checkout inside or around one is not staging.
 */
export function ephemeralStagingRoot(filePath: string): string | undefined {
	return classifyTmpDir(path.dirname(path.resolve(filePath))).stagingRoot;
}

/**
 * True for a directory inside a real git checkout below the host temporary
 * directory: the checkout root itself or any subdirectory of it. Such
 * checkouts are normal within one process and never persisted across
 * processes (#1129 decision B).
 */
export function isEphemeralCheckoutRoot(dir: string): boolean {
	return classifyTmpDir(dir).checkout;
}
