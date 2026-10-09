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
import { isUnderDir, isVendorPath } from "./path-utils.js";
import { isPiLensInternalPath } from "./file-utils.js";
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

/** The selected filesystem root, or undefined for a refused path. */
export function resolveAnalysisRootPath(
	filePath: string,
	sessionRoot: string,
): string | undefined {
	const resolved = nodePath.resolve(filePath);
	const session = nodePath.resolve(sessionRoot);
	if (isVendorPath(resolved)) return undefined;
	if (
		resolved === os.tmpdir() ||
		resolved === session ||
		isUnderDir(session, resolved) ||
		(!isUnderDir(resolved, session) && isPiLensInternalPath(resolved, session))
	)
		return undefined;
	if (isUnderDir(resolved, session)) return session;
	const checkout = resolveGitCheckout(session);
	const linked = checkout && resolveLinkedWorktreeOwner(checkout, resolved);
	if (linked) return linked.root;
	const candidate = nearestProjectRoot(resolved);
	if (!candidate || candidate === nodePath.parse(candidate).root)
		return undefined;
	const home = nodePath.resolve(os.homedir());
	if (candidate === home || isUnderDir(candidate, home)) return undefined;
	if (candidate === os.tmpdir() || isUnderDir(session, candidate))
		return undefined;
	if (isVendorPath(candidate)) return undefined;
	return candidate;
}

export function resolveAnalysisRoot(
	filePath: string,
	sessionRoot: string,
): AnalysisRootMode {
	const checkout = resolveGitCheckout(sessionRoot);
	if (checkout && resolveLinkedWorktreeOwner(checkout, filePath)) {
		return "linked-worktree";
	}
	const root = resolveAnalysisRootPath(filePath, sessionRoot);
	if (!root) return "none";
	if (root === nodePath.resolve(sessionRoot)) return "session";
	return "adopted";
}

export function canWriteAnalysisRoot(mode: AnalysisRootMode): boolean {
	return mode === "session" || mode === "linked-worktree";
}
