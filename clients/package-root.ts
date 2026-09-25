import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageRootCache = new Map<string, string>();

/**
 * Resolve the installed package root for the current module.
 * Walks upward from the caller until it finds the nearest package.json.
 *
 * This is the correct alternative to process.cwd() for resolving
 * pi-lens's own assets (rules, grammars, configs) when installed
 * globally — cwd is the user's project, not the extension root.
 *
 * Credit: alexx-ftw (PR #1)
 */
export function getPackageRoot(importMetaUrl: string): string {
	const cached = packageRootCache.get(importMetaUrl);
	if (cached) return cached;

	let current = path.dirname(fileURLToPath(importMetaUrl));
	while (true) {
		if (fs.existsSync(path.join(current, "package.json"))) {
			packageRootCache.set(importMetaUrl, current);
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			packageRootCache.set(importMetaUrl, current);
			return current;
		}
		current = parent;
	}
}

/**
 * Resolve a path relative to the installed package root.
 */
export function resolvePackagePath(
	importMetaUrl: string,
	...segments: string[]
): string {
	return path.join(getPackageRoot(importMetaUrl), ...segments);
}

const WEB_TREE_SITTER = "web-tree-sitter";

/**
 * Walk up from `start` to the nearest `web-tree-sitter` directory, or undefined
 * when the walk reaches the filesystem root without meeting one. Guards against
 * returning an unrelated ancestor for a package whose `exports` map points into
 * a subdirectory.
 */
function walkUpToWebTreeSitter(start: string): string | undefined {
	let dir = start;
	while (path.basename(dir) !== WEB_TREE_SITTER && dir !== path.dirname(dir)) {
		dir = path.dirname(dir);
	}
	return path.basename(dir) === WEB_TREE_SITTER ? dir : undefined;
}

/**
 * web-tree-sitter's own installed package directory, or undefined.
 *
 * ONE ladder for every caller that needs to know where that package lives — the
 * grammar READ path, the lazy-fetch WRITE path, and the install-diagnostics
 * probe. Before #3409 each answered the question with its own rungs, and the two
 * that led with a BARE specifier were unconditionally broken on the host pi
 * actually ships: inside a `bun build --compile` binary
 * `require.resolve("web-tree-sitter")` throws MODULE_NOT_FOUND while
 * `require.resolve("web-tree-sitter/tree-sitter.wasm")` — an explicit file
 * subpath — still resolves (reporter's transcript on #3409).
 *
 * Rung order, most authoritative first:
 *  1. the `tree-sitter.wasm` SUBPATH, which is in the package's `exports` map
 *     and resolves on a compiled host as well as a plain one. This is the rung
 *     that makes the non-core grammars fetchable there at all.
 *  2. the BARE specifier, for a future web-tree-sitter whose exports map no
 *     longer carries `./tree-sitter.wasm` (the #381 0.26 migration).
 *  3. pi-lens's own package root, for the temp-dir compile layout (#20) where
 *     the resolver's context is a temp directory but the package root still has
 *     the right `node_modules`.
 *  4. the working directory, the pre-existing last resort.
 *
 * Every input is injected, never defaulted: the caller's own resolver context
 * and package root are the things that differ on a compiled host, so they must
 * not be silently replaced by this module's — and a rung nothing can vary is a
 * rung no test can drive.
 */
export function resolveWebTreeSitterPackageDir(deps: {
	resolve: (specifier: string) => string;
	packageRoot: () => string;
	cwd: () => string;
}): string | undefined {
	for (const specifier of [
		`${WEB_TREE_SITTER}/tree-sitter.wasm`,
		WEB_TREE_SITTER,
	]) {
		try {
			const dir = walkUpToWebTreeSitter(path.dirname(deps.resolve(specifier)));
			if (dir) return dir;
		} catch {
			/* next rung */
		}
	}
	try {
		const fromPackageRoot = path.join(
			deps.packageRoot(),
			"node_modules",
			WEB_TREE_SITTER,
		);
		if (fs.existsSync(fromPackageRoot)) return fromPackageRoot;
	} catch {
		/* next rung */
	}
	const fromCwd = path.join(deps.cwd(), "node_modules", WEB_TREE_SITTER);
	return fs.existsSync(fromCwd) ? fromCwd : undefined;
}
