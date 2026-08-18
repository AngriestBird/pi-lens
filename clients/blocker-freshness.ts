/**
 * Turn-boundary freshness gate for cached inline blockers (#1631).
 *
 * An inline blocker recorded for a file F is a verdict about F *and everything F
 * imports*. The existing invalidation paths all key on F alone — a later dispatch
 * of the SAME path returning no blockers, the path ceasing to exist (#1245), and a
 * fresh confirmed-clean verdict (#1561/#1573). When only a DEPENDENCY of F changes,
 * none of those events fire, so F's stale verdict re-served at every turn end for
 * the rest of the session. The live instances in #1631 are exactly that shape: the
 * missing export was added to the dependency (one via a bash script, so the
 * dependency was never dispatched at all — even the same-path event was unreachable
 * by construction).
 *
 * The gate here is a READ-time freshness sweep, not the #1561 dependency-axis
 * invalidation (which stays blocked on a maintainer design decision). Before a cached
 * blocking finding is re-served at turn end, stat the file and its forward imports.
 * The file's own import list comes from the parse layer — no reverse-dependency index
 * is needed, sidestepping the tests-free-index blocker that holds #1561's remainder.
 *
 * Drifted entries are DEMOTED, not dropped (#1419 precedent, as applied by sibling
 * issue #1622): a surviving file whose content drifted gets re-served with a
 * `[stale — re-run to confirm]` marker and out of the authoritative blocker channel,
 * rather than being silently deleted or re-asserted at full authority. The gate never
 * re-pulls LSP verdicts on its own — a drifted entry is marked stale and left for an
 * explicit re-run or the next dispatch to resolve. That keeps the sweep bounded and
 * free of the document-resync hazard the issue calls out (re-querying an LSP whose
 * in-memory dependency document is itself stale would regenerate the stale verdict).
 */
import * as fs from "node:fs";
import { resolveImportToFiles } from "./review-graph/import-resolvers.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import {
	getSharedTreeSitterClient,
	resolveTreeSitterLanguage,
} from "./tree-sitter-shared.js";
import { TreeSitterSymbolExtractor } from "./tree-sitter-symbol-extractor.js";

/** Per-turn result of the freshness sweep over the cached inline blockers. */
export interface BlockerFreshnessCounts {
	/** Cached blocker entries present when the sweep ran. */
	total: number;
	/** No drift detected this turn — re-served as an authoritative blocker. */
	kept: number;
	/** Drift detected this turn — demoted to `[stale — re-run to confirm]`. */
	revalidated: number;
	/** Removed by the gate this turn (drift confirmed resolved). */
	retired: number;
	/** Already demoted on a prior turn and still stale — re-served as `[stale]`. */
	alreadyStale: number;
}

/**
 * Resolves a blocker file's forward imports to in-project file paths. Injected in
 * tests; the production default parses the file with the shared tree-sitter client
 * and resolves each import source through the review-graph import resolvers.
 */
export type ForwardImportResolver = (
	cwd: string,
	filePath: string,
) => Promise<string[]> | string[];

export interface BlockerFreshnessOptions {
	/** Wall-clock baseline override; defaults to `Date.now()`. Test seam only. */
	now?: number;
	/** Forward-import resolution override; defaults to tree-sitter extraction. */
	resolveForwardImports?: ForwardImportResolver;
}

/**
 * Upper bound on the number of forward imports stat-checked for a single blocker.
 * Blocking entries are rare, but one file can import many modules; the sweep must
 * stay bounded so it cannot inflate a turn end.
 */
const MAX_DRIFT_CHECK_IMPORTS = 128;

// Per-language extractor cache, mirroring review-graph/builder.ts and
// module-report.ts. Memoize failures too: a grammar that fails to load once is not
// re-probed for every blocker of that language within the process.
const extractorCache = new Map<
	string,
	Promise<TreeSitterSymbolExtractor | null>
>();

function getExtractor(
	languageId: string,
): Promise<TreeSitterSymbolExtractor | null> {
	let cached = extractorCache.get(languageId);
	if (!cached) {
		cached = (async () => {
			const client = getSharedTreeSitterClient();
			if (!client) return null;
			const extractor = new TreeSitterSymbolExtractor(languageId, client);
			const ok = await extractor.init();
			return ok ? extractor : null;
		})().catch(() => null);
		extractorCache.set(languageId, cached);
	}
	return cached;
}

/** Test-only: clear the extractor memo so a grammar state change re-probes. */
export function _resetBlockerFreshnessForTests(): void {
	extractorCache.clear();
}

/**
 * Production forward-import resolver. Parses `filePath` with its tree-sitter grammar
 * and resolves every extracted import source to in-project files. Degrades to an
 * empty list (never throws) when the grammar, client, or file is unavailable — the
 * sweep then falls back to checking only the blocker file's own drift.
 */
export async function extractForwardImportPaths(
	cwd: string,
	filePath: string,
): Promise<string[]> {
	const languageId = resolveTreeSitterLanguage(filePath);
	if (!languageId) return [];
	const client = getSharedTreeSitterClient();
	if (!client) return [];
	const extractor = await getExtractor(languageId);
	if (!extractor) return [];

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	const outcome = await client.withParsedTree(
		filePath,
		languageId,
		content,
		(tree) => extractor.extract(tree, filePath, content).imports,
	);
	if (!outcome.parsed) return [];

	const resolved = new Set<string>();
	for (const ref of outcome.value) {
		for (const target of resolveImportToFiles(
			cwd,
			filePath,
			languageId,
			ref.source,
		)) {
			resolved.add(target);
		}
	}
	return [...resolved];
}

async function statMtimeMs(filePath: string): Promise<number | undefined> {
	try {
		const stat = await fs.promises.stat(filePath);
		return stat.mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * Resolve `filePath`'s forward imports and stat each, returning the imports that
 * exist together with their mtime. Shared by the inline-blocker sweep and the
 * widget-store dependency reconcile so both gates weigh drift identically. A path
 * that cannot be stat'ed (deleted/unreadable) is omitted — a deleted dependency is
 * not a content drift this gate reports.
 */
export async function collectForwardImportMtimes(
	cwd: string,
	filePath: string,
	resolveForwardImports: ForwardImportResolver = extractForwardImportPaths,
): Promise<Array<{ path: string; mtimeMs: number }>> {
	let imports: string[] = [];
	try {
		imports = await resolveForwardImports(cwd, filePath);
	} catch {
		imports = [];
	}
	const out: Array<{ path: string; mtimeMs: number }> = [];
	for (const dep of imports.slice(0, MAX_DRIFT_CHECK_IMPORTS)) {
		const mtimeMs = await statMtimeMs(dep);
		if (mtimeMs !== undefined) out.push({ path: dep, mtimeMs });
	}
	return out;
}

/**
 * Detect drift for one blocker entry. Returns the set of paths (the file itself plus
 * any forward import) whose mtime is strictly newer than the verdict baseline. A
 * missing/unstat-able path contributes nothing here — a DELETED blocker file is
 * already dropped by `reconcileInlineBlockers`, and a deleted dependency is not a
 * content drift this gate is responsible for.
 *
 * +1ms tolerance, the same convention as `reconcileStaleWidgetFiles` and
 * `reconcileProjectDiagnosticsSnapshot`: the verdict baseline is a whole-millisecond
 * `Date.now()`, but filesystem mtimes carry sub-millisecond precision, so a file
 * written in the very millisecond the verdict was recorded can otherwise read as
 * drifted and demote a blocker that was correct when taken.
 */
async function detectDrift(
	cwd: string,
	filePath: string,
	recordedAtMs: number,
	resolveForwardImports: ForwardImportResolver,
): Promise<string[]> {
	const drifted: string[] = [];
	const ownMtimeMs = await statMtimeMs(filePath);
	if (ownMtimeMs !== undefined && ownMtimeMs > recordedAtMs + 1) {
		drifted.push(filePath);
	}
	for (const { path, mtimeMs } of await collectForwardImportMtimes(
		cwd,
		filePath,
		resolveForwardImports,
	)) {
		if (mtimeMs > recordedAtMs + 1) drifted.push(path);
	}
	return drifted;
}

/**
 * Freshness sweep over the cached inline blockers. Called at turn end before the
 * blockers are re-served. Entries whose own file or forward imports drifted since the
 * verdict are demoted via `markInlineBlockerStale`; the turn-end renderer then serves
 * them out of the advisory channel with a `[stale — re-run to confirm]` marker instead
 * of as an authoritative blocker.
 *
 * Never throws: any internal failure leaves the entry untouched (existing re-serve
 * behavior) rather than failing the turn end.
 */
export async function sweepInlineBlockerFreshness(
	runtime: RuntimeCoordinator,
	cwd: string,
	options?: BlockerFreshnessOptions,
): Promise<BlockerFreshnessCounts> {
	const counts: BlockerFreshnessCounts = {
		total: 0,
		kept: 0,
		revalidated: 0,
		retired: 0,
		alreadyStale: 0,
	};
	const resolveForwardImports =
		options?.resolveForwardImports ?? extractForwardImportPaths;

	let entries: Array<{ filePath: string; stale?: boolean; recordedAtMs?: number }>;
	try {
		entries = runtime.getInlineBlockersSnapshot();
	} catch {
		return counts;
	}
	counts.total = entries.length;

	for (const entry of entries) {
		try {
			if (entry.stale) {
				counts.alreadyStale += 1;
				continue;
			}
			// No timestamp baseline (legacy/unstamped record) — we cannot order disk
			// mtimes against the verdict, so leave it untouched (fail toward the
			// existing behavior rather than fabricating a drift signal).
			if (entry.recordedAtMs === undefined) {
				counts.kept += 1;
				continue;
			}
			const drifted = await detectDrift(
				cwd,
				entry.filePath,
				entry.recordedAtMs,
				resolveForwardImports,
			);
			if (drifted.length > 0) {
				runtime.markInlineBlockerStale(entry.filePath);
				counts.revalidated += 1;
			} else {
				counts.kept += 1;
			}
		} catch {
			// Per-entry failure: keep the entry as-is.
			counts.kept += 1;
		}
	}
	return counts;
}
