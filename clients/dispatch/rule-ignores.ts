/**
 * Per-rule path carve-outs (`ignores:` in a rule's own YAML, #965).
 *
 * ONE matcher, shared by every surface that decides whether a rule may fire on
 * a path: the NAPI ast-grep runner, the tree-sitter runner (`ignore_paths`),
 * and — since #3041 — the LSP output seam (`applyAuxiliarySuppressions`).
 *
 * #3041, measured against ast-grep 0.45.3: `ast-grep scan` applies a rule's
 * `ignores` globs during its own project walk, but `ast-grep lsp` publishes
 * per-document diagnostics WITHOUT applying them — the same rule on the same
 * file is filtered by the CLI and unfiltered over LSP. So every pi-lens path
 * that delivers ast-grep's LSP diagnostics has to apply the carve-out itself;
 * the runner-side matcher below is what it applies.
 */

import * as path from "node:path";
import { minimatch } from "../deps/minimatch.js";
import { getAstGrepRuleSources } from "../sgconfig.js";
import {
	loadYamlRules,
	loadYamlRulesFresh,
} from "./runners/yaml-rule-parser.js";

/**
 * True when `filePath` is carved out of a rule by one of its glob `patterns`.
 *
 * The glob is matched against `filePath` relative to `root`, forward-slashed.
 * Falls back to the absolute (slash-normalized) path when `filePath` isn't
 * under `root` (e.g. an out-of-tree temp file), so a glob like `scripts/**`
 * simply never matches rather than throwing.
 */
export function isRuleIgnoredForPath(
	filePath: string,
	root: string,
	patterns: readonly string[] | undefined,
): boolean {
	if (!patterns || patterns.length === 0) return false;
	const relative = path.relative(root, filePath);
	const displayPath = (relative.startsWith("..") ? filePath : relative)
		.split(path.sep)
		.join("/");
	return patterns.some((pattern) =>
		minimatch(displayPath, pattern, { dot: true }),
	);
}

/**
 * Rule id → its `ignores` globs, for the effective ast-grep catalog at `root`.
 *
 * Same sources, same precedence, and the same two loaders the NAPI runner uses
 * (project rule trees are mutable within a session, bundled catalogs are not),
 * so the LSP seam carves out exactly the paths the runner carves out. Both
 * loaders are cached, so this is ~0.09 ms per call on pi-lens's own catalog
 * (17 rules with `ignores`, measured) — cheap enough to call per file rather
 * than thread a preloaded map through every sweep.
 *
 * Keyed by the EXACT rule id, matching the runner: a `-js` twin (e.g.
 * `no-console-except-error-js`) carries its own `ignores` in its own document,
 * so normalizing the suffix here would apply one document's carve-out to the
 * other's findings.
 */
export function loadRuleIgnorePatterns(
	root: string,
): ReadonlyMap<string, readonly string[]> {
	const patterns = new Map<string, readonly string[]>();
	for (const source of getAstGrepRuleSources(root)) {
		let rules;
		try {
			rules =
				source.origin === "project"
					? loadYamlRulesFresh(source.dir)
					: loadYamlRules(source.dir);
		} catch {
			continue;
		}
		for (const rule of rules) {
			// First source wins, matching the runner's cross-layer precedence.
			if (patterns.has(rule.id) || !rule.ignores?.length) continue;
			patterns.set(rule.id, rule.ignores);
		}
	}
	return patterns;
}
