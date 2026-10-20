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

export function resolveAnalysisRoot(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): AnalysisRootMode {
	const resolved = realPathOrResolved(filePath);
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
 * #2657 + #4242: the root a session should REGISTER for `filePath`, or
 * `undefined` when this file's mode must register NOTHING.
 *
 * Pre-fix, the `tool_call` seam registered `path.dirname(filePath)`, so a
 * session touching 128 directories cycled the FIFO(128) session-root registry
 * and evicted the project root — which carries the operator's
 * `lsp.disabledServers` denial — until something re-registered it, and
 * `getConfigForFile` walked a population that grew with the number of
 * directories an agent happened to touch. Registering the file's WORKSPACE
 * fixes that population, but only for the modes that may declare one
 * (`resolveAnalysisRoot` is the answer, this function only routes it):
 *
 * - `session` → the NEAREST directory at or above the file that holds a
 *   `.pi-lens.json`/`pi-lens.json`, never above the session root, else the
 *   session root. The config loader layers upward from the registered root, so
 *   that root must sit at or below the nearest config owner or a nested config
 *   stops applying;
 * - `linked-worktree` → the linked worktree's OWN root, so per-worktree
 *   isolation is preserved (maintainer decision on #1129);
 * - `adopted` / `none` → `undefined`, i.e. register nothing.
 *
 * The last line is the analysis-root invariant (AGENTS.md): an adopted root is
 * separate from session roots, capped at two with idle eviction, and never
 * reaches project-local executables by default. Registering one here answers
 * `session` from `ClientRegistry.analysisRootModeForFile`, which skips
 * `admitAdoptedRoot` — voiding the cap, the idle window, and the
 * project-local-binary refusal for the whole adopted project, not just the
 * directory a call named. #2657's population argument does not need it:
 * `session` and `linked-worktree` are the modes that carry session bookkeeping.
 */
export function resolveSessionConfigRoot(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): string | undefined {
	const session = nodePath.resolve(sessionRoot);
	const mode = resolveAnalysisRoot(filePath, session, homeDirOverride);
	if (mode === "linked-worktree") {
		const checkout = resolveGitCheckout(session);
		return (
			(checkout &&
				resolveLinkedWorktreeOwner(checkout, realPathOrResolved(filePath))
					?.root) ??
			session
		);
	}
	if (mode !== "session") return undefined;
	const start = nodePath.dirname(nodePath.resolve(filePath));
	for (const dir of walkUpDirs(start)) {
		if (dir !== session && !isUnderDir(dir, session)) break;
		if (findPiLensConfigInDir(dir)) return dir;
		if (dir === session) break;
	}
	return session;
}
