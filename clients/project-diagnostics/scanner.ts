import * as fs from "node:fs";
import * as path from "node:path";
import { createDispatchContext } from "../dispatch/dispatcher.js";
import { evaluateRules } from "../dispatch/fact-rule-runner.js";
import { runProviders } from "../dispatch/fact-runner.js";
import { FactStore } from "../dispatch/fact-store.js";
import {
	canHandle as astGrepCanHandle,
	evaluateAstGrepRules,
	getLang as astGrepGetLang,
	loadSg,
} from "../dispatch/runners/ast-grep-napi.js";
import type { Diagnostic } from "../dispatch/types.js";
import { isTestFile } from "../file-utils.js";
import { isAtOrAboveHomeDir } from "../path-utils.js";
import { getProjectDiagnosticsScannerMaxFiles } from "../project-scale.js";
import { collectSourceFilesWithBudgetAsync } from "../source-filter.js";
import { logTreeSitterCacheStats } from "../tree-sitter-logger.js";
import {
	queriesForLanguage,
	queryLoader,
} from "../tree-sitter-query-loader.js";
import { getSharedTreeSitterClient } from "../tree-sitter-shared.js";
import {
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	saveProjectDiagnosticsSnapshot,
} from "./cache.js";
import type {
	ProjectDiagnostic,
	ProjectDiagnosticsScanOptions,
	ProjectDiagnosticsSnapshot,
} from "./types.js";
// Side-effect import: registers fact providers and fact rules.
import "../dispatch/integration.js";

// Skip files this large: matches the per-edit ast-grep runner's guard so a single
// generated megafile can't dominate a project scan.
const AST_GREP_MAX_FILE_BYTES = 1024 * 1024;
// Project-audit budgets — looser than the per-edit runner's 10/50 (which exist to
// keep inline output bounded), since a project scan is an explicit, expensive call.
const AST_GREP_SCAN_MAX_MATCHES_PER_RULE = 25;
const AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE = 100;
const FACT_RULE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
]);
const TREE_SITTER_EXT_TO_LANG: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	// .tsx parses with the TSX grammar, not typescript: the typescript grammar
	// produces ERROR nodes on JSX, and this id must match the one the fact
	// providers resolve (`resolveTreeSitterLanguage`) or the file is parsed
	// twice under two grammars. Typescript RULES still apply — see the
	// query-set merge below, which compiles them against tsx.
	".tsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".rb": "ruby",
};


function normalizeSeverity(
	severity: string | undefined,
): ProjectDiagnostic["severity"] {
	if (severity === "error" || severity === "warning" || severity === "hint") {
		return severity;
	}
	return severity === "info" ? "info" : "warning";
}

function normalizeSemantic(
	diagnostic: Diagnostic,
): ProjectDiagnostic["semantic"] {
	if (diagnostic.semantic === "blocking") return "blocking";
	if (diagnostic.semantic === "warning") return "warning";
	return "none";
}

function fromDispatchDiagnostic(
	diagnostic: Diagnostic,
	runner: string,
): ProjectDiagnostic {
	return {
		filePath: path.resolve(diagnostic.filePath),
		line: diagnostic.line,
		column: diagnostic.column,
		severity: normalizeSeverity(diagnostic.severity),
		semantic: normalizeSemantic(diagnostic),
		tool: diagnostic.tool,
		runner,
		rule: diagnostic.rule,
		code: diagnostic.code,
		message: diagnostic.message,
		source: "project-scan",
	};
}

interface TreeSitterAndFactScan {
	treeSitter: ProjectDiagnostic[];
	factRules: ProjectDiagnostic[];
}

/**
 * One FILE-major pass for the two runners that both tree-sitter-parse the same
 * file (#675). Run phase-major, the fact rules re-parsed every file the
 * tree-sitter rules had already parsed — a 50-entry cache cannot span a
 * whole-project sweep, so all 357 of a 500-file scan's first touches missed on
 * capacity. Per file the second runner now reads the tree the first one just
 * cached. Results stay in separate lists so the snapshot's diagnostic order is
 * unchanged.
 */
async function scanTreeSitterAndFactRules(
	cwd: string,
	files: string[],
	signal?: AbortSignal,
): Promise<TreeSitterAndFactScan> {
	const client = getSharedTreeSitterClient();
	const treeSitterReady =
		!!client && client.isAvailable() && (await client.init());
	// Same singleton the dispatch runner uses (tree-sitter.ts:444) — memoized
	// per root, so repeated scans stop re-reading the ~180 query YAMLs.
	const queryMap = treeSitterReady
		? await queryLoader.loadQueries(cwd)
		: undefined;

	const facts = new FactStore();
	const pi = { getFlag: () => undefined };
	const treeSitter: ProjectDiagnostic[] = [];
	const factRules: ProjectDiagnostic[] = [];
	let filesScanned = 0;

	const scan = async (): Promise<void> => {
		for (const filePath of files) {
			if (signal?.aborted) break;
			if (isTestFile(filePath)) continue;
			const ext = path.extname(filePath);
			const langId = TREE_SITTER_EXT_TO_LANG[ext];
			const factEligible = FACT_RULE_EXTENSIONS.has(ext);
			if (!langId && !factEligible) continue;
			filesScanned++;

			if (queryMap && langId && client) {
				const queries = queriesForLanguage(queryMap, langId);
				try {
					// ONE tree walk for the whole rule set, not one per rule (#675).
					const found = await client.runQueriesOnFile(queries, filePath, langId, {
						maxResults: 50,
					});
					for (const { queryDef: query, match } of found) {
						treeSitter.push({
							filePath,
							line: match.line ?? 1,
							column: match.column,
							severity: query.severity === "error" ? "error" : query.severity,
							semantic:
								query.inline_tier === "blocking" || query.severity === "error"
									? "blocking"
									: "warning",
							tool: "tree-sitter",
							runner: "tree-sitter",
							rule: query.id,
							message: query.message,
							source: "project-scan",
						});
					}
				} catch {
					// Continue scanning other rules/files.
				}
			}

			if (factEligible) {
				facts.clearFileFactsFor(filePath);
				const ctx = createDispatchContext(filePath, cwd, pi, facts, false);
				try {
					await runProviders(ctx);
					for (const diagnostic of evaluateRules(ctx)) {
						factRules.push(fromDispatchDiagnostic(diagnostic, "fact-rules"));
					}
				} catch {
					// Project scans are best-effort; one unparsable file should not abort the tool.
				}
			}
		}
	};

	if (!client) {
		await scan();
		return { treeSitter, factRules };
	}

	const startedAt = Date.now();
	await client.withParseCacheMeasurement(scan, (stats) => {
		logTreeSitterCacheStats({
			scope: "project_diagnostics_scan",
			filePath: cwd,
			fileCount: filesScanned,
			durationMs: Date.now() - startedAt,
			stats,
		});
	});
	return { treeSitter, factRules };
}

/**
 * Project-wide ast-grep pass via the bundled napi engine — no `ast-grep` binary
 * required (#308). In `lens_diagnostics mode=full` the ast-grep LSP already
 * covers the project WHEN its binary is present; this closes the no-binary gap
 * using the same Rust core + shipped ruleset. Findings dedup against the LSP's
 * (`filePath:line:rule`) in the full-mode merge, so running both never
 * double-reports. Iterates the SAME `files` list as the other scanners, so it
 * inherits identical exclusion/ignore/cap behavior automatically.
 */
async function scanAstGrepNapi(
	cwd: string,
	files: string[],
): Promise<ProjectDiagnostic[]> {
	const sgModule = await loadSg();
	if (!sgModule) return [];

	const diagnostics: ProjectDiagnostic[] = [];
	for (const filePath of files) {
		if (isTestFile(filePath) || !astGrepCanHandle(filePath)) continue;

		let stats: fs.Stats;
		try {
			stats = fs.statSync(filePath);
		} catch {
			continue;
		}
		if (stats.size > AST_GREP_MAX_FILE_BYTES) continue;

		const lang = astGrepGetLang(filePath, sgModule);
		if (!lang) continue;

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			const rootNode = lang.parse(content).root();
			const fileDiagnostics = evaluateAstGrepRules(
				filePath,
				rootNode,
				cwd,
				"jsts",
				{
					maxMatchesPerRule: AST_GREP_SCAN_MAX_MATCHES_PER_RULE,
					maxTotalDiagnostics: AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE,
				},
			);
			for (const diagnostic of fileDiagnostics) {
				diagnostics.push(fromDispatchDiagnostic(diagnostic, "ast-grep-napi"));
			}
		} catch {
			// Project scans are best-effort; one unparsable file must not abort the tool.
		}
	}
	return diagnostics;
}

export async function scanProjectDiagnostics(
	options: ProjectDiagnosticsScanOptions,
): Promise<ProjectDiagnosticsSnapshot> {
	const cwd = path.resolve(options.cwd);
	const { signal } = options;
	// #747/#250: refuse to WALK from a cwd at — or above — the home directory.
	// The cheap tier is bounded by DEFAULT_MAX_FILES, but from $HOME it still
	// traverses a huge unrelated tree until it happens to keep that many source
	// files. An explicit `files` list (#461) is a caller-chosen subset, not a
	// walk, so it is never refused here. Same ceiling as fresh-fetch.ts.
	if (!options.files && isAtOrAboveHomeDir(cwd, options.homeDir)) {
		return {
			version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
			cwd,
			tier: options.tier,
			scannedAt: new Date().toISOString(),
			diagnostics: [],
			filesScanned: 0,
			runners: [],
			unsafeRoot: true,
		};
	}
	const maxFiles = Math.max(
		1,
		options.maxFiles ?? getProjectDiagnosticsScannerMaxFiles(cwd),
	);
	// #760: bound the walk by entries VISITED, not just files kept — a mixed
	// tree with few source files among a huge pile of non-source files never
	// trips `maxFiles`. Unlike `unsafeRoot` this is not a refusal: when the
	// budget trips we scan the truncated best-effort list and flag the snapshot
	// so callers don't read the partial result as a complete sweep.
	const collected = options.files
		? { files: options.files.slice(0, maxFiles), entryBudgetExceeded: false }
		: await collectSourceFilesWithBudgetAsync(cwd, {
				maxFiles,
				maxScanEntries: options.maxScanEntries,
			});
	const files = collected.files;
	// Check cancellation at each phase boundary so a full-mode scan stops
	// promptly when the agent/user aborts (#341). The per-phase runners are
	// already file-capped, so phase granularity is enough to bound the work.
	const runners: string[] = [];
	const diagnostics: ProjectDiagnostic[] = [];
	if (!signal?.aborted) {
		// Both runners parse the same file, so they share ONE file-major pass
		// (#675) — the per-file order is what keeps the second one on a cache hit.
		const scanned = await scanTreeSitterAndFactRules(cwd, files, signal);
		diagnostics.push(...scanned.treeSitter, ...scanned.factRules);
		runners.push("tree-sitter", "fact-rules");
	}
	if (!signal?.aborted) {
		diagnostics.push(...(await scanAstGrepNapi(cwd, files)));
		runners.push("ast-grep-napi");
	}
	const snapshot: ProjectDiagnosticsSnapshot = {
		version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
		cwd,
		tier: options.tier,
		scannedAt: new Date().toISOString(),
		diagnostics,
		filesScanned: files.length,
		runners,
	};
	// #760: only present when true — keeps existing snapshots/serializations
	// byte-identical for the untruncated (normal) case.
	if (collected.entryBudgetExceeded) snapshot.scanTruncated = true;
	// A cancelled scan yields a partial snapshot; don't persist it as the
	// authoritative cross-session cache — only a complete run is cacheable.
	// Likewise, an explicit `files` scan (#461) only covers a caller-chosen
	// subset (e.g. git-staged files), not the whole project — persisting it
	// would poison the cross-session cache with a partial view that a later
	// unscoped `refreshRunners=cached` read would wrongly trust as complete.
	if (signal?.aborted || options.files) return snapshot;
	saveProjectDiagnosticsSnapshot(cwd, snapshot);
	return snapshot;
}
