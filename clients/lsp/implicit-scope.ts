/**
 * #4346: files that change another file's diagnostics while no import names
 * them, the part of a file's dependency scope no import graph holds.
 *
 * - A JS or TS file sees the global scope that ambient files feed: a
 *   declaration file, a file with `declare global` or `declare module`, and a
 *   script (a file with no import or export, so its top-level declarations are
 *   global). A new `globals.d.ts` answers `Cannot find name 'FOO'` in a file
 *   that never imports it; no graph build has an edge for it (#4368 probe: the
 *   source walk leaves declaration files out).
 * - A Go file shares its package with every Go file in its directory, and
 *   uses their declarations with no import.
 *
 * {@link implicitScopeOf} is the one membership test. The workspace-diagnostics
 * cache reads it for an entry's dependency scope (`workspace-diagnostics-cache.ts`),
 * the inline-blocker sweep for a blocker's (`blocker-freshness.ts`), and the
 * cascade in the inverse direction, for the files a change reaches
 * (`dispatch/integration.ts`, #4438). The created-module producer announces a
 * Go file's package files to its servers (`created-import-targets.ts`). Other
 * languages' implicit scopes are not modelled; the cache treats their finding
 * entries' scope as unknown.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadAstGrepNapiSync, type SgNode } from "../deps/ast-grep-napi.js";
import { recordDegradationOnce } from "../degradation-ledger.js";
import { isFileKind } from "../file-kinds.js";
import { isDeclarationFile } from "../generated-artifacts.js";
import { exceedsLspSyncLimits } from "./content-limits.js";

/** Whether `filePath` is a Go source file. */
export function isGoSourceFile(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() === ".go";
}

/** Whether `filePath` is a JS or TS file, which sees the TS/JS global scope. */
function seesJsTsGlobalScope(filePath: string): boolean {
	return isFileKind(filePath, "jsts");
}

/**
 * Whether `a` and `b`, both spelled by `normalizeMapKey` (forward slashes on
 * every platform), are Go files of one package directory.
 */
function inOneGoPackage(a: string, b: string): boolean {
	return (
		isGoSourceFile(a) &&
		isGoSourceFile(b) &&
		path.posix.dirname(a) === path.posix.dirname(b)
	);
}

/**
 * The Go files in `dir`, as absolute paths; `undefined` when the directory
 * cannot be read.
 */
export function goPackageFiles(dir: string): string[] | undefined {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	return entries.flatMap((entry) =>
		entry.isFile() && isGoSourceFile(entry.name)
			? [path.join(dir, entry.name)]
			: [],
	);
}

/**
 * #4438: `filePath`'s implicit scope as a membership test, or `undefined` when
 * it is not modelled (a file neither Go nor JS/TS). The scope of a Go file is
 * the Go files of its directory; of a JS/TS file, every file that feeds the
 * TS/JS global scope (`feeds`, {@link feedsJsTsGlobalScope} unless a caller
 * memoizes it). A file is never in its own scope. `filePath` and every member
 * asked about are `normalizeMapKey` spellings.
 */
export function implicitScopeOf(
	filePath: string,
	feeds: (other: string) => boolean = feedsJsTsGlobalScope,
): ((other: string) => boolean) | undefined {
	if (isGoSourceFile(filePath)) {
		return (other) => other !== filePath && inOneGoPackage(filePath, other);
	}
	if (seesJsTsGlobalScope(filePath)) {
		return (other) => other !== filePath && feeds(other);
	}
	return undefined;
}

/**
 * #4346, moved here by #4438: when the Go package in `dir` last changed: the
 * directory's own mtime (a file added, removed or renamed) or the newest Go
 * file's, leaving `exclude` (a path as {@link goPackageFiles} spells it) out.
 * `undefined` when the directory or a file cannot be stat'ed, which callers
 * read as changed.
 */
export function goPackageChangedAt(
	dir: string,
	exclude?: string,
): number | undefined {
	try {
		let changedAt = fs.statSync(dir).mtimeMs;
		for (const peer of goPackageFiles(dir) ?? []) {
			if (peer === exclude) continue;
			changedAt = Math.max(changedAt, fs.statSync(peer).mtimeMs);
		}
		return changedAt;
	} catch {
		return undefined;
	}
}

/** What a parse of `filePath` must look for, by extension. */
type GlobalScopeProbe = "ts-script-or-ambient" | "ambient" | "js-script";

function probeFor(filePath: string): GlobalScopeProbe | undefined {
	switch (path.extname(filePath).toLowerCase()) {
		case ".ts":
		case ".tsx":
			return "ts-script-or-ambient";
		// ES and CommonJS module extensions: never a script, but a TS one can
		// still hold `declare global`.
		case ".mts":
		case ".cts":
			return "ambient";
		case ".js":
		case ".jsx":
			return "js-script";
		default:
			return undefined;
	}
}

/**
 * Whether `filePath` feeds the TS/JS global scope. A declaration file always
 * counts. A TS file counts when it is a script or holds `declare global` or
 * `declare module`; a `.js`/`.jsx` file when it is a script with no CommonJS
 * marker (`require(...)`, `module.exports`, `exports.x`), which TypeScript
 * treats as a module. `.mjs`, `.cjs`, Vue and Svelte files never count.
 *
 * Fails closed: an unreadable file, one over the LSP sync limits, or a parser
 * that does not load answers true, so the caller refuses rather than serves.
 * A parser that does not load is recorded once per session.
 */
export function feedsJsTsGlobalScope(filePath: string): boolean {
	if (isDeclarationFile(filePath)) return true;
	const probe = probeFor(filePath);
	if (!probe) return false;
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return true;
	}
	if (exceedsLspSyncLimits(content).tooLarge) return true;
	const napi = loadAstGrepNapiSync();
	if (!napi) {
		recordDegradationOnce({
			kind: "ast-grep-napi-unavailable",
			subject: "implicit-scope",
			reason:
				"native addon failed to load; every created JS/TS file counts as feeding the global scope",
		});
		return true;
	}
	const lang =
		probe === "js-script"
			? napi.Lang.JavaScript
			: path.extname(filePath).toLowerCase() === ".tsx"
				? napi.Lang.Tsx
				: napi.Lang.TypeScript;
	let root: SgNode;
	try {
		root = napi.parse(lang, content).root();
	} catch {
		return true;
	}
	let isModule = false;
	for (const child of root.children()) {
		const kind = child.kind();
		if (kind === "import_statement" || kind === "export_statement") {
			isModule = true;
		} else if (
			kind === "ambient_declaration" &&
			child
				.children()
				.some((part) => part.kind() === "global" || part.kind() === "module")
		) {
			return true;
		}
	}
	if (probe === "ambient" || isModule) return false;
	if (probe === "js-script") {
		return !["require($$$ARGS)", "module.exports", "exports.$NAME"].some(
			(pattern) => root.find(pattern) !== null,
		);
	}
	return true;
}
