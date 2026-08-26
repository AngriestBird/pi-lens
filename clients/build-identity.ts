/**
 * #1775: `sessionstart.log` recorded no build identity — no commit hash, no
 * dirty flag, no build timestamp. Dogfood forensics ("does this session
 * include PR #1727?") had to reconstruct that by hand: run
 * `git merge-base --is-ancestor` in the serving checkout and compare `dist/`
 * mtimes against the session-start time.
 *
 * The running extension can be a different checkout than the repo an
 * investigator is looking at, so identity is derived from the RUNNING
 * build's own files — `getPackageRoot` (already used by grammar-source.ts to
 * find pi-lens's own assets under both the unbundled dev layout and a
 * packaged install) plus the mtime of the very entry file that is executing
 * right now — never from `process.cwd()` and never assumed to be a git
 * checkout.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageRoot } from "./package-root.js";

export interface BuildIdentity {
	/** Short commit hash of the serving checkout, or "unknown" (no .git, or
	 *  a packaged install with git metadata stripped). */
	commit: string;
	/** Working-tree dirty flag; undefined when git metadata is unavailable. */
	dirty?: boolean;
	/** mtime of the running entry file (index.js) — the build's own timestamp,
	 *  correct under both the unbundled dev layout and a bundled `dist/` install. */
	entryMtime: string;
	/** package.json version — always available, the fallback identity for a
	 *  packaged install with no git metadata at all. */
	version: string;
}

function isInsideGitRepo(startDir: string): boolean {
	let dir = path.resolve(startDir);
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return true;
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

function readPackageVersion(root: string): string {
	try {
		const raw = fs.readFileSync(path.join(root, "package.json"), "utf-8");
		const pkg = JSON.parse(raw) as { version?: string };
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** #2095 lesson: execFileSync inherits the child's stderr to THIS process by
 *  default, so a failing git call must pipe stderr away explicitly rather
 *  than let a raw "fatal: ..." line leak into the host's TUI. */
function runGit(root: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
			cwd: root,
		}).trim();
	} catch {
		return undefined;
	}
}

function getCommitAndDirty(root: string): {
	commit: string;
	dirty?: boolean;
} {
	if (!isInsideGitRepo(root)) return { commit: "unknown" };
	const commit = runGit(root, ["rev-parse", "--short", "HEAD"]);
	if (commit === undefined) return { commit: "unknown" };
	const status = runGit(root, ["status", "--porcelain"]);
	return { commit, dirty: status === undefined ? undefined : status.length > 0 };
}

/**
 * Resolve the identity of the build currently running. `entryImportMetaUrl`
 * must be the ENTRY module's own `import.meta.url` (index.ts) — passing a
 * different module's URL would report that module's mtime instead of the
 * running build's.
 */
export function getBuildIdentity(entryImportMetaUrl: string): BuildIdentity {
	const root = getPackageRoot(entryImportMetaUrl);
	const { commit, dirty } = getCommitAndDirty(root);
	const version = readPackageVersion(root);
	let entryMtime = "unknown";
	try {
		entryMtime = fs
			.statSync(fileURLToPath(entryImportMetaUrl))
			.mtime.toISOString();
	} catch {
		// Entry path unresolvable (e.g. a non-file:// URL under test) — leave
		// "unknown" rather than throw out of a session-start observability line.
	}
	return { commit, dirty, entryMtime, version };
}

/** One bounded, human-readable line for sessionstart.log's free-text writer. */
export function formatBuildIdentity(identity: BuildIdentity): string {
	const dirtyLabel =
		identity.dirty === undefined ? "unknown" : identity.dirty ? "yes" : "no";
	return `session_start: build identity — commit=${identity.commit} dirty=${dirtyLabel} entryMtime=${identity.entryMtime} version=${identity.version}`;
}
