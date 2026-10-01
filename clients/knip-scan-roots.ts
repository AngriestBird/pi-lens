/**
 * Which directories turn_end runs knip in (#3872).
 *
 * Its own module, not part of `knip-client.ts`: `runtime-turn.ts` imports only
 * the TYPES of the client, and a value import would pull the client's leaf-
 * bounded awaits into the hook-await one-hop pin set (`tests/config/
 * hook-await-bounds.test.ts`) for the sake of one synchronous function.
 */

import { dirname, resolve } from "node:path";
import { pathsEqual } from "./path-utils.js";
import { resolveGitCheckout } from "./review-graph/git-identity.js";

/**
 * Distinct checkouts one turn_end may scan. Each is a whole-project knip run,
 * so a turn that edited many linked worktrees must not start one process per
 * worktree inside a 3 s hook budget.
 */
export const MAX_KNIP_ROOTS_PER_TURN = 3;

/**
 * The directories turn_end runs knip in, session root first.
 *
 * An edit belongs to the checkout that owns it. The session cwd keeps every
 * edit it owned before, and every edit whose owner cannot be established or is
 * an unrelated repository (a submodule, a nested clone) -- those stay part of
 * the session's own scan, exactly as today. Only an edit in a LINKED WORKTREE
 * of the session's repository (same commondir, different top level) is scanned
 * in that worktree's own root: knip at the session root would otherwise count
 * the edited file through a nested copy of the whole project.
 *
 * A session cwd outside any git checkout, or a turn with no modified files,
 * scans the session cwd only. `overCap` lists the roots beyond
 * {@link MAX_KNIP_ROOTS_PER_TURN}; the caller records them as skipped.
 */
export function resolveKnipScanRoots(
	sessionCwd: string,
	modifiedFiles: readonly string[],
): { roots: string[]; overCap: string[] } {
	const session = resolveGitCheckout(sessionCwd);
	if (!session || modifiedFiles.length === 0) {
		return { roots: [sessionCwd], overCap: [] };
	}
	let sessionOwnsEdit = false;
	const linked: string[] = [];
	for (const file of modifiedFiles) {
		const owner = resolveGitCheckout(dirname(resolve(sessionCwd, file)));
		const isLinkedWorktree =
			owner !== null &&
			!pathsEqual(owner.root, session.root) &&
			pathsEqual(owner.commonDir, session.commonDir);
		if (!isLinkedWorktree) {
			sessionOwnsEdit = true;
		} else if (!linked.some((root) => pathsEqual(root, owner.root))) {
			linked.push(owner.root);
		}
	}
	const roots = sessionOwnsEdit ? [sessionCwd, ...linked] : linked;
	return {
		roots: roots.slice(0, MAX_KNIP_ROOTS_PER_TURN),
		overCap: roots.slice(MAX_KNIP_ROOTS_PER_TURN),
	};
}
