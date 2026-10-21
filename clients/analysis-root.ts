/**
 * Classifies the root that owns one file for tool_result bookkeeping.
 *
 * This is the one root-selection seam shared by tool-result bookkeeping and
 * LSP admission. Callers still decide which work they own, but they must use
 * the root selected here rather than re-discovering a marker independently.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
	isAtOrAboveHomeDir,
	isUnderDir,
	isVendorPath,
	pathsEqual,
	realpathOrResolve,
} from "./path-utils.js";
import { isPiLensInternalPath } from "./file-utils.js";
import {
	resolveGitCheckout,
	resolveLinkedWorktreeOwner,
	sameCheckoutOtherRoot,
} from "./review-graph/git-identity.js";

export type AnalysisRootMode =
	| "session"
	| "linked-worktree"
	| "adopted"
	| "none";

const PROJECT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"Gemfile",
	"mix.exs",
	"composer.json",
];

function hasProjectMarker(dir: string): boolean {
	return PROJECT_MARKERS.some((marker) => {
		try {
			const stat = fs.statSync(nodePath.join(dir, marker));
			return stat.isFile() || marker === ".git";
		} catch {
			return false;
		}
	});
}

function nearestProjectRoot(filePath: string): string | undefined {
	let dir = nodePath.dirname(nodePath.resolve(filePath));
	const filesystemRoot = nodePath.parse(dir).root;
	while (dir !== filesystemRoot) {
		if (hasProjectMarker(dir)) return dir;
		dir = nodePath.dirname(dir);
	}
	return hasProjectMarker(filesystemRoot) ? filesystemRoot : undefined;
}

/** The selected filesystem root, or undefined for a refused path. */
export function resolveAnalysisRootPath(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): string | undefined {
	const resolved = realpathOrResolve(filePath);
	const session = realpathOrResolve(sessionRoot);
	const tmp = realpathOrResolve(os.tmpdir());
	const data = process.env.PI_LENS_HOME
		? realpathOrResolve(process.env.PI_LENS_HOME)
		: undefined;
	if (isVendorPath(resolved)) return undefined;
	if (
		resolved === tmp ||
		resolved === session ||
		isUnderDir(session, resolved) ||
		(!isUnderDir(resolved, session) &&
			(isPiLensInternalPath(resolved, session) ||
				(data !== undefined &&
					(resolved === data || isUnderDir(resolved, data)))))
	)
		return undefined;
	if (isUnderDir(resolved, session)) return session;
	const checkout = resolveGitCheckout(session);
	const linked = checkout && resolveLinkedWorktreeOwner(checkout, resolved);
	if (linked && !isVendorPath(resolved)) return linked.root;
	const candidate = nearestProjectRoot(resolved);
	if (!candidate || candidate === nodePath.parse(candidate).root)
		return undefined;
	const home = realpathOrResolve(homeDirOverride ?? os.homedir());
	// D1: sibling projects below $HOME are eligible; only $HOME itself and
	// ancestors are refused. Keep the shared ceiling in isAtOrAboveHomeDir.
	if (isAtOrAboveHomeDir(candidate, home)) return undefined;
	if (candidate === tmp || isUnderDir(session, candidate)) return undefined;
	if (isVendorPath(candidate)) return undefined;
	return candidate;
}

export function resolveAnalysisRoot(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): AnalysisRootMode {
	const resolved = realpathOrResolve(filePath);
	if (isVendorPath(resolved)) return "none";
	const checkout = resolveGitCheckout(sessionRoot);
	if (checkout && resolveLinkedWorktreeOwner(checkout, resolved)) {
		return "linked-worktree";
	}
	const root = resolveAnalysisRootPath(filePath, sessionRoot, homeDirOverride);
	if (!root) return "none";
	if (root === nodePath.resolve(sessionRoot)) return "session";
	return "adopted";
}

export function canWriteAnalysisRoot(mode: AnalysisRootMode): boolean {
	return mode === "session" || mode === "linked-worktree";
}

/**
 * May this ROOT receive session bookkeeping? The session root, a directory
 * under it, and the session repository's linked worktrees may; an adopted
 * project must not (AGENTS.md "Analysis-root invariant"). The root form of
 * {@link resolveAnalysisRoot}, which answers "session" for any file under the
 * session root (a monorepo package's client is rooted there, #4532 round 5,
 * review F7): checkout identity is read at the root itself, not at a child
 * path, so a caller holding a root asks the owner instead of re-deriving the
 * rule.
 */
export function isSessionBookkeepingRoot(
	root: string,
	sessionRoot: string,
): boolean {
	const resolved = realpathOrResolve(root);
	// The file form's first refusal (#4532 round 6, verify r5): every file
	// under a vendor root resolves to "none", so the root is no session's.
	if (isVendorPath(resolved)) return false;
	const session = realpathOrResolve(sessionRoot);
	if (pathsEqual(resolved, session) || isUnderDir(resolved, session))
		return true;
	const checkout = resolveGitCheckout(session);
	if (!checkout) return false;
	// The owner rule itself, asked of two ROOTS instead of a root and a file
	// (#4532 round 4, NITPICK-1): this used to be a second spelling of
	// `resolveLinkedWorktreeOwner`'s predicate, on `===` rather than `pathsEqual`.
	return sameCheckoutOtherRoot(checkout, resolveGitCheckout(resolved));
}
