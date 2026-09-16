/**
 * #3170 — the bounded persistent-reverify pass.
 *
 * A finding whose own file is unchanged is re-delivered turn after turn from
 * the persisted actionable-warnings report without ever being re-observed
 * against the live server: the in-band publish carries forward DEFERRED-origin
 * file entries while their file has not moved (`mergeActionableWarningsReports`'s
 * scope guard), and the delta freshness gate passes them because the file's
 * mtime has not moved either. When the root cause was fixed in a DIFFERENT
 * file, the carried finding is stale in fact but fresh by every on-disk axis.
 *
 * This module re-observes those files before the turn_end advisory assembles:
 * a collecting `touchFile` (the same path the `source=lsp` probe uses — no
 * second observation mechanism), a fresh record conversion through
 * `recordFromLspDiagnostic`, and an in-band REPLACEMENT report published
 * through the normal publisher — so the carried entry is superseded (not
 * unioned with) by the fresh observation.
 *
 * Bounds (the issue's contract): at most {@link MAX_REVERIFY_FILES} files per
 * turn_end, a wall budget of {@link REVERIFY_BUDGET_MS}, the turn-end abort
 * signal, and no new durable state — candidates come from the persisted
 * report itself, which is what was delivered last turn.
 */

import * as fs from "node:fs";
import { logLatency } from "./latency-logger.js";
import type { LSPDiagnostic } from "./lsp/client.js";
import type { LSPTouchClientScope } from "./lsp/index.js";
import type {
	ActionableWarningsReport,
	ActionableWarningsReportFile,
} from "./actionable-warnings.js";
import { recordFromLspDiagnostic } from "./actionable-warnings.js";

/** At most this many files are re-observed per turn_end (the drift backstop's
 * own 4-resyncs-per-pass precedent). */
export const MAX_REVERIFY_FILES = 4;

/** Wall-clock budget for the whole pass; a touch that cannot answer inside
 * its remaining slice is recorded unconfirmed, never waited out. */
export const REVERIFY_BUDGET_MS = 3000;

/** The touch options the `source=lsp` probe uses, with this pass's source. */
const TOUCH_SOURCE = "persistent_reverify";

export interface PersistentReverifyOutcome {
	filePath: string;
	displayPath: string;
	/** clean = the server no longer reports the carried findings;
	 * reconfirmed = every carried finding still matches a fresh diagnostic;
	 * mixed = some matched, some did not; unconfirmed = no answer inside the
	 * budget (the carried entry is kept verbatim and labeled). */
	outcome: "clean" | "reconfirmed" | "mixed" | "unconfirmed";
	dropped: number;
	kept: number;
}

export interface PersistentReverifyResult {
	outcomes: PersistentReverifyOutcome[];
	/** File entries carrying the fresh observation (or the incomplete marker),
	 * ready to publish in-band so the carried entries are superseded. */
	replacementFiles: ActionableWarningsReportFile[];
	candidates: number;
	touched: number;
	skippedChanged: number;
	skippedBudget: number;
}

/** Structural minimal for the touch-bearing service — the real service
 * satisfies it; tests script it. */
export interface ReverifyLspService {
	touchFile: (
		filePath: string,
		content: string,
		opts: {
			diagnostics: "document";
			collectDiagnostics: boolean;
			maxClientWaitMs: number;
			source: string;
			clientScope: LSPTouchClientScope;
		},
	) => Promise<
		| {
				diags?: LSPDiagnostic[];
				inconclusive?: boolean;
		  }
		| undefined
	>;
}

/**
 * Select the report's re-verify candidates: DEFERRED-origin file entries (the
 * only population the in-band publish carries forward, so the only population
 * that re-serves across turns) whose file stat is UNCHANGED since the entry's
 * own observation stamp. A file that changed is skipped — the edit path
 * already re-observed it. Missing files are skipped too: the delta freshness
 * gate drops them outright.
 */
export function selectPersistentReverifyFiles(
	report: ActionableWarningsReport,
	nowMs: number = Date.now(),
): ActionableWarningsReportFile[] {
	const candidates: ActionableWarningsReportFile[] = [];
	for (const entry of report.files) {
		if (entry.origin !== "deferred") continue;
		if (entry.reVerified || entry.reVerifyIncomplete) continue;
		const stamp = entry.generatedAt ? Date.parse(entry.generatedAt) : NaN;
		if (!Number.isFinite(stamp) || stamp > nowMs) continue;
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(entry.filePath).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs > stamp) continue;
		candidates.push(entry);
		if (candidates.length >= MAX_REVERIFY_FILES) break;
	}
	return candidates;
}

/**
 * Run the bounded re-verify pass over the report's candidates and build the
 * in-band replacement entries. Never throws: an unexpected per-file failure
 * degrades that file to `unconfirmed` (kept verbatim, labeled), which is the
 * shape-48 direction — the harm reaching the user is a hidden real finding,
 * worse than re-delivering a stale one.
 */
export async function runPersistentReverify(args: {
	report: ActionableWarningsReport;
	cwd: string;
	lspService: ReverifyLspService;
	signal?: AbortSignal;
	nowMs?: number;
}): Promise<PersistentReverifyResult> {
	const started = Date.now();
	const nowMs = args.nowMs ?? started;
	const candidates = selectPersistentReverifyFiles(args.report, nowMs);
	const outcomes: PersistentReverifyOutcome[] = [];
	const replacementFiles: ActionableWarningsReportFile[] = [];
	let touched = 0;
	let skippedChanged = 0;
	let skippedBudget = 0;

	for (const entry of candidates) {
		if (args.signal?.aborted || Date.now() - started >= REVERIFY_BUDGET_MS) {
			skippedBudget += 1;
			continue;
		}
		let content: string;
		try {
			content = fs.readFileSync(entry.filePath, "utf-8");
		} catch {
			outcomes.push({
				filePath: entry.filePath,
				displayPath: entry.displayPath,
				outcome: "unconfirmed",
				dropped: 0,
				kept: entry.warnings.length,
			});
			replacementFiles.push({ ...entry, reVerifyIncomplete: true });
			continue;
		}
		let touchedResult: Awaited<ReturnType<ReverifyLspService["touchFile"]>> =
			undefined;
		try {
			touchedResult = await args.lspService.touchFile(entry.filePath, content, {
				diagnostics: "document",
				collectDiagnostics: true,
				maxClientWaitMs: Math.max(
					250,
					REVERIFY_BUDGET_MS - (Date.now() - started),
				),
				source: TOUCH_SOURCE,
				clientScope: "primary",
			});
		} catch {
			touchedResult = undefined;
		}
		if (
			touchedResult === undefined ||
			touchedResult.inconclusive === true ||
			touchedResult.diags === undefined
		) {
			outcomes.push({
				filePath: entry.filePath,
				displayPath: entry.displayPath,
				outcome: "unconfirmed",
				dropped: 0,
				kept: entry.warnings.length,
			});
			replacementFiles.push({ ...entry, reVerifyIncomplete: true });
			continue;
		}
		touched += 1;
		const freshRecords = touchedResult.diags.flatMap((d) =>
			d.range?.start?.line === undefined
				? []
				: [recordFromLspDiagnostic(d, entry.filePath, args.cwd)],
		);
		const observedAt = nowMs;
		let dropped = 0;
		let kept = 0;
		for (const warning of entry.warnings) {
			const stillThere = freshRecords.some(
				(record) =>
					record.rule === warning.rule && record.message === warning.message,
			);
			if (stillThere) kept += 1;
			else dropped += 1;
		}
		let outcome: PersistentReverifyOutcome["outcome"] = "mixed";
		if (freshRecords.length === 0) outcome = "clean";
		else if (dropped === 0) outcome = "reconfirmed";
		outcomes.push({
			filePath: entry.filePath,
			displayPath: entry.displayPath,
			outcome,
			dropped,
			kept,
		});
		replacementFiles.push({
			...entry,
			warnings: freshRecords,
			reVerified: true,
			generatedAt: new Date(observedAt).toISOString(),
		});
	}

	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: args.cwd,
		phase: "persistent_reverify",
		durationMs: Date.now() - started,
		metadata: {
			candidates: candidates.length,
			touched,
			clean: outcomes.filter((o) => o.outcome === "clean").length,
			reconfirmed: outcomes.filter((o) => o.outcome === "reconfirmed").length,
			mixed: outcomes.filter((o) => o.outcome === "mixed").length,
			unconfirmed: outcomes.filter((o) => o.outcome === "unconfirmed").length,
			skippedChanged,
			skippedBudget,
		},
	});

	return {
		outcomes,
		replacementFiles,
		candidates: candidates.length,
		touched,
		skippedChanged,
		skippedBudget,
	};
}

/** True when the persisted report holds at least one re-verify candidate —
 * the zero-I/O gate for callers that would otherwise read the cache every
 * turn for nothing. Deferred-origin entries only. */
export function hasReverifyCandidates(candidates: number): boolean {
	return candidates > 0;
}
