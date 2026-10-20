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
	walkUpDirs,
} from "./path-utils.js";
import { isPiLensInternalPath } from "./file-utils.js";
import { findPiLensConfigInDir } from "./project-lens-config.js";
import {
	resolveGitCheckout,
	resolveLinkedWorktreeOwner,
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

function realPathOrResolved(filePath: string): string {
	const resolved = nodePath.resolve(filePath);
	let current = resolved;
	const missing: string[] = [];
	while (true) {
		try {
			const real = fs.realpathSync.native(current);
			return nodePath.join(real, ...missing.reverse());
		} catch {
			const parent = nodePath.dirname(current);
			if (parent === current) return resolved;
			missing.push(nodePath.basename(current));
			current = parent;
		}
	}
}

/** The selected filesystem root, or undefined for a refused path. */
export function resolveAnalysisRootPath(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): string | undefined {
	const resolved = realPathOrResolved(filePath);
	const session = realPathOrResolved(sessionRoot);
	const tmp = realPathOrResolved(os.tmpdir());
	const data = process.env.PI_LENS_HOME
		? realPathOrResolved(process.env.PI_LENS_HOME)
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
	const home = realPathOrResolved(homeDirOverride ?? os.homedir());
	// D1: sibling projects below $HOME are eligible; only $HOME itself and
	// ancestors are refused. Keep the shared ceiling in isAtOrAboveHomeDir.
	if (isAtOrAboveHomeDir(candidate, home)) return undefined;
	if (candidate === tmp || isUnderDir(session, candidate)) return undefined;
	if (isVendorPath(candidate)) return undefined;
	return candidate;
}

/**
 * The class AND the owning root, answered once (#2657). `resolveAnalysisRoot`
 * is the mode-only projection of this; a caller that needs the root for the
 * class must not re-derive it from a second rule — `resolveAnalysisRootPath`
 * is the eligibility rule for an out-of-session path and answers `undefined`
 * for a worktree root inside a pi-owned temp dir, which is not what the class
 * said.
 */
function classifyAnalysisRoot(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): { mode: AnalysisRootMode; root: string | undefined } {
	const resolved = realPathOrResolved(filePath);
	if (isVendorPath(resolved)) return { mode: "none", root: undefined };
	const checkout = resolveGitCheckout(sessionRoot);
	const owner = checkout
		? resolveLinkedWorktreeOwner(checkout, resolved)
		: null;
	if (owner) return { mode: "linked-worktree", root: owner.root };
	const root = resolveAnalysisRootPath(filePath, sessionRoot, homeDirOverride);
	if (!root) return { mode: "none", root: undefined };
	if (root === nodePath.resolve(sessionRoot)) return { mode: "session", root };
	return { mode: "adopted", root };
}

export function resolveAnalysisRoot(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): AnalysisRootMode {
	return classifyAnalysisRoot(filePath, sessionRoot, homeDirOverride).mode;
}

export function canWriteAnalysisRoot(mode: AnalysisRootMode): boolean {
	return mode === "session" || mode === "linked-worktree";
}

/** What a session declares to its root registries for one file (#2657). */
export interface SessionConfigRoot {
	/**
	 * The root to hand `ensureLSPConfigInitialized`, or `undefined` when the
	 * session must register NOTHING for this file.
	 */
	register: string | undefined;
	/** The owning class, as {@link resolveAnalysisRoot} answered it. */
	mode: AnalysisRootMode;
}

/**
 * #2657: the root a session should REGISTER for `filePath`, declared as one
 * workspace rather than one directory, and whether it may register at all.
 *
 * Pre-fix, the `tool_call` seam registered `path.dirname(filePath)`, so a
 * session touching 128 directories cycled the FIFO(128) session-root registry
 * and evicted the project root — which carries the operator's
 * `lsp.disabledServers` denial — until something re-registered it, and
 * `getConfigForFile` walked a population that grew with the number of
 * directories an agent happened to touch.
 *
 * The registration follows the CLASS, never the directory:
 *
 * 1. `session` — register the nearest directory at or above the file that
 *    holds a `.pi-lens.json`/`pi-lens.json`, never above the session root. The
 *    config loader layers upward from the registered root, so that root must
 *    sit at or below the nearest config owner or a nested config stops
 *    applying; otherwise the session root itself.
 * 2. `linked-worktree` — register the worktree root: it is its own workspace
 *    with its own `.pi-lens.json`, and `resolveServerRoot`'s #2052 gate refuses
 *    a file outside every registered root, so registering nothing would deny
 *    the worktree its LSP client. Per-worktree isolation is preserved
 *    (maintainer decision on #1129).
 * 3. `adopted` — register NOTHING. An adopted root is a foreign project, never
 *    a session root: it is served through the `adopted` branch of
 *    `resolveServerRoot` and admitted by `ClientRegistry.admitAdoptedRoot`,
 *    which is capped, idle-evicted, and refuses its project-local binaries.
 *    Registering it would launder `adopted` into `session` for
 *    `analysisRootModeForFile` and skip every one of those rules.
 * 4. `none` — register nothing; `tool_result` announces the skip.
 *
 * The population is therefore O(workspaces + nested config owners), not
 * O(directories touched).
 */
export function resolveSessionConfigRoot(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): SessionConfigRoot {
	const session = nodePath.resolve(sessionRoot);
	const { mode, root } = classifyAnalysisRoot(
		filePath,
		sessionRoot,
		homeDirOverride,
	);
	if (mode === "adopted" || mode === "none")
		return { register: undefined, mode };
	// A linked worktree registers its own root — the owner the class resolved,
	// never the edited file's directory and never a re-derived eligibility.
	if (mode === "linked-worktree") return { register: root, mode };
	const start = nodePath.dirname(nodePath.resolve(filePath));
	if (!isUnderDir(start, session)) return { register: session, mode };
	for (const dir of walkUpDirs(start)) {
		if (dir !== session && !isUnderDir(dir, session)) break;
		if (findPiLensConfigInDir(dir)) return { register: dir, mode };
		if (dir === session) break;
	}
	return { register: session, mode };
}
