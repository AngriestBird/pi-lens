/**
 * Which checkout root owns turn_end test selection for one edit (#3871).
 *
 * Its own module for the same reason as `knip-scan-roots.ts`: a pure,
 * synchronous resolver that `runtime-turn.ts` can import without pulling
 * `test-runner-client.ts`'s awaits into a one-hop pin set.
 */

import { dirname } from "node:path";
import {
	type GitCheckout,
	resolveGitCheckout,
	resolveLinkedWorktreeOwner,
} from "./review-graph/git-identity.js";

/**
 * Distinct linked worktrees one turn_end may select and run tests in. The
 * session checkout is not counted: it was always selected. Every other root
 * pays its own runner detection, failed-target lookup and spawns, so a turn
 * that edited many worktrees must not fan out across all of them inside the
 * turn_end budget (the per-turn target cap bounds spawns, not roots).
 */
export const MAX_LINKED_TEST_ROOTS_PER_TURN = 3;

export interface TestRootVerdict {
	/**
	 * The directory test selection and the runner treat as the project root for
	 * this file: the session cwd, or a linked worktree's own top level in the
	 * spelling `absoluteFile` used (the spelling the turn's file keys carry).
	 */
	root: string;
	/** True when `root` is a linked worktree beyond the per-turn cap: select nothing there. */
	overCap: boolean;
}

export interface TurnEndTestRoots {
	/** The root that owns `absoluteFile`; memoised per directory for the turn. */
	rootFor(absoluteFile: string): TestRootVerdict;
	/** Linked-worktree roots refused by the cap this turn, each once. */
	overCapRoots(): string[];
}

/**
 * A per-turn resolver. An edit belongs to the checkout that owns it. The
 * session cwd keeps every edit it owned before, and every edit whose owner is
 * unresolvable or an unrelated repository (a submodule, a nested clone): those
 * stay foreign and `isExcludedTestTarget` rejects them exactly as it did. Only
 * a LINKED WORKTREE of the session's repository (same commondir, different top
 * level) is its own root: tests for an edit there run in that worktree, with
 * its own config and `node_modules`, never against the session checkout.
 */
export function createTurnEndTestRoots(sessionCwd: string): TurnEndTestRoots {
	const session = resolveGitCheckout(sessionCwd);
	const ownerByDir = new Map<string, GitCheckout | null>();
	const admitted: string[] = [];
	const refused: string[] = [];
	return {
		rootFor(absoluteFile) {
			if (session === null) return { root: sessionCwd, overCap: false };
			const dir = dirname(absoluteFile);
			let owner = ownerByDir.get(dir);
			if (owner === undefined) {
				owner = resolveLinkedWorktreeOwner(session, absoluteFile);
				ownerByDir.set(dir, owner);
			}
			if (owner === null) return { root: sessionCwd, overCap: false };
			if (admitted.includes(owner.root)) {
				return { root: owner.spelledRoot, overCap: false };
			}
			if (admitted.length < MAX_LINKED_TEST_ROOTS_PER_TURN) {
				admitted.push(owner.root);
				return { root: owner.spelledRoot, overCap: false };
			}
			if (!refused.includes(owner.spelledRoot)) refused.push(owner.spelledRoot);
			return { root: owner.spelledRoot, overCap: true };
		},
		overCapRoots: () => [...refused],
	};
}
