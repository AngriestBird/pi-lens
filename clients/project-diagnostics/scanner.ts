import * as fs from "node:fs";
import * as path from "node:path";
import { createDispatchContext } from "../dispatch/dispatcher.js";
import { evaluateRules } from "../dispatch/fact-rule-runner.js";
import { runProviders } from "../dispatch/fact-runner.js";
import { FactStore } from "../dispatch/fact-store.js";
import {
	canHandle as astGrepCanHandle,
	getLang as astGrepGetLang,
	evaluateAstGrepRules,
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
import {
	EXT_TO_LANG,
	getSharedTreeSitterClient,
} from "../tree-sitter-shared.js";
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
// Which languages the scan runs tree-sitter rules for: every language that has
// (a loadable grammar) AND (a non-disabled rules/tree-sitter-queries/<lang>/ dir).
//
// The base is the shared per-edit resolver (EXT_TO_LANG — the single
// ext→grammar-id authority), so c/cpp/csharp/php/css and the .tsx→tsx /
// .jsx→javascript nuances can never drift from the per-edit path. `.tsx` resolves
// to the tsx grammar (not typescript: the typescript grammar ERRORs on JSX);
// typescript RULES still apply because `queriesForLanguage(...)` below merges the
// typescript rule set onto tsx.
//
// java + kotlin are layered on here: they have loadable grammars and rule dirs
// (java: 24 rules, kotlin: 1) but no per-edit runner `appliesTo` entry, so only
// this broad project scan runs them. scanner.test.ts asserts this map covers
// every non-disabled rule dir whose grammar is loadable, so adding a language dir
// fails a test until its extension is registered here (or in EXT_TO_LANG).
export const TREE_SITTER_EXT_TO_LANG: Record<string, string> = {
	...EXT_TO_LANG,
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
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

interface FileMajorScan {
	treeSitter: ProjectDiagnostic[];
	factRules: ProjectDiagnostic[];
	astGrep: ProjectDiagnostic[];
}

/**
 * One FILE-major pass for every in-process syntax consumer (#675/#896).
 * Per-consumer gates preserve their distinct language and size eligibility,
 * while separate result lists preserve the historical phase-major diagnostic
 * ordering.
 */
async function scanFileMajorRules(
	cwd: string,
	files: string[],
	signal?: AbortSignal,
): Promise<FileMajorScan> {
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
	const astGrep: ProjectDiagnostic[] = [];
	const sgModule = await loadSg();
	let phaseOneFilesScanned = 0;
	let astGrepFilesScanned = 0;
	let astGrepDurationMs = 0;

	const scanTreeSitterFile = async (
		filePath: string,
		langId: string | undefined,
		content: string | null,
	): Promise<void> => {
		if (!queryMap || !langId || !client || content === null) return;
		const queries = queriesForLanguage(queryMap, langId);
		try {
			const found = await client.runQueriesOnFile(
				queries,
				filePath,
				langId,
				{ maxResults: 50 },
				content,
			);
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
	};

	const scanFactRulesFile = async (
		filePath: string,
		content: string | null,
	): Promise<void> => {
		facts.clearFileFactsFor(filePath);
		// Seed the exact bytes already supplied to tree-sitter so the file-content
		// provider is skipped by runProviders.
		facts.setFileFact(filePath, "file.content", content);
		const ctx = createDispatchContext(filePath, cwd, pi, facts, false);
		try {
			await runProviders(ctx);
			for (const diagnostic of evaluateRules(ctx)) {
				factRules.push(fromDispatchDiagnostic(diagnostic, "fact-rules"));
			}
		} catch {
			// Project scans are best-effort; one unparsable file should not abort the tool.
		}
	};

	const scanAstGrepFile = (
		filePath: string,
		content: string,
		lang: NonNullable<ReturnType<typeof astGrepGetLang>>,
	): void => {
		const startedAt = Date.now();
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
				astGrep.push(fromDispatchDiagnostic(diagnostic, "ast-grep-napi"));
			}
		} catch {
			// Project scans are best-effort; one unparsable file must not abort the tool.
		} finally {
			astGrepFilesScanned++;
			astGrepDurationMs += Date.now() - startedAt;
		}
	};

	const scan = async (): Promise<void> => {
		for (const filePath of files) {
			if (signal?.aborted) break;
			if (isTestFile(filePath)) continue;
			const ext = path.extname(filePath);
			const langId = TREE_SITTER_EXT_TO_LANG[ext];
			const factEligible = FACT_RULE_EXTENSIONS.has(ext);
			let astGrepLang: ReturnType<typeof astGrepGetLang> | undefined;
			if (sgModule && astGrepCanHandle(filePath)) {
				try {
					if (fs.statSync(filePath).size <= AST_GREP_MAX_FILE_BYTES) {
						astGrepLang = astGrepGetLang(filePath, sgModule);
					}
				} catch {
					// A missing file is ineligible for every content consumer below.
				}
			}
			if (!langId && !factEligible && !astGrepLang) continue;
			if (langId || factEligible) phaseOneFilesScanned++;

			let content: string | null;
			try {
				content = fs.readFileSync(filePath, "utf-8");
			} catch {
				content = null;
			}

			await scanTreeSitterFile(filePath, langId, content);

			if (factEligible) {
				await scanFactRulesFile(filePath, content);
			}

			if (signal?.aborted) {
				// The former phase-major scan never started ast-grep after a
				// phase-one abort. Discard earlier ast-grep work from this merged
				// pass to preserve that partial-result contract.
				astGrep.length = 0;
				break;
			}
			if (astGrepLang && content !== null) {
				scanAstGrepFile(filePath, content, astGrepLang);
			}
		}
	};

	if (!client) {
		await scan();
		return { treeSitter, factRules, astGrep };
	}

	const startedAt = Date.now();
	await client.withParseCacheMeasurement(scan, (stats) => {
		logTreeSitterCacheStats({
			scope: "project_diagnostics_scan",
			filePath: cwd,
			fileCount: phaseOneFilesScanned,
			durationMs: Date.now() - startedAt,
			stats,
		});
	});
	await client.withParseCacheMeasurement(async () => {}, (stats) => {
		logTreeSitterCacheStats({
			scope: "project_diagnostics_ast_grep_scan",
			filePath: cwd,
			fileCount: astGrepFilesScanned,
			durationMs: astGrepDurationMs,
			stats,
		});
	});
	return { treeSitter, factRules, astGrep };
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
	// Check cancellation before and during the file-major pass so a full-mode
	// scan stops promptly when the agent/user aborts (#341).
	const runners: string[] = [];
	const diagnostics: ProjectDiagnostic[] = [];
	if (!signal?.aborted) {
		// All in-process syntax consumers share one file-major pass (#675/#896).
		const scanned = await scanFileMajorRules(cwd, files, signal);
		diagnostics.push(...scanned.treeSitter, ...scanned.factRules);
		runners.push("tree-sitter", "fact-rules");
		if (!signal?.aborted) {
			diagnostics.push(...scanned.astGrep);
			runners.push("ast-grep-napi");
		}
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
