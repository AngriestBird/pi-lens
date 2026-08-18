/**
 * Past-EOF validity gate for cited diagnostic line numbers (#1641).
 *
 * A live session served diagnostics at lines 407-410 of a file that was 402
 * lines on disk and UNMODIFIED — the LSP's in-memory document had drifted
 * longer than disk without any file write happening (no didChange lost, just
 * an in-memory buffer that grew past what the file actually contains). That
 * makes this a DIFFERENT invariant than #1622/#1627's freshness gate: those
 * compare a cited file's MTIME against a scan timestamp, which says nothing
 * when the file was never touched on disk at all. The cheap, orthogonal check
 * available here is structural: a diagnostic whose start line exceeds the
 * file's CURRENT line count cannot possibly be describing current content,
 * regardless of what any timestamp says.
 *
 * CONTRACT:
 *   - A diagnostic citing a line beyond the file's current line count is
 *     DEMOTED (`stale: true`), never dropped — the underlying issue may well
 *     still be real, just at a coordinate this gate can no longer vouch for.
 *   - Fail open: a file that cannot be stat'ed/read yields no verdict at all
 *     (every diagnostic passes through unchanged). An unreadable file is not
 *     evidence of anything; demoting on it would manufacture false staleness.
 *   - Cost discipline: one `statSync` + (when needed) one read per file per
 *     render pass, via a {@link LineCountCache} the CALLER creates fresh for
 *     that pass and discards afterward — never a module-level/cross-request
 *     cache. A persistent cache here would recreate exactly the staleness
 *     class this arc exists to kill (a cached verdict outliving the state it
 *     was computed from); a pass-scoped map has no lifetime to go stale
 *     across, by construction. Each render pass touches a given file at most
 *     a handful of times regardless, so the memo only dedupes stat/read calls
 *     WITHIN one pass (e.g. a file appearing in both a widget summary and a
 *     freshly-merged LSP result in the same `lens_diagnostics` call).
 *   - On a demotion, best-effort trigger a document resync (didClose/didOpen
 *     or a full-sync didChange) so the desync HEALS instead of re-serving the
 *     same stale verdict next time (#1631's resync-before-revalidate rule).
 *     Resync is fire-and-forget: a failure here must never block or fail the
 *     render path that discovered the drift.
 */
import * as fs from "node:fs";
import { logLatency } from "./latency-logger.js";
import { toProjectRelativePath } from "./path-utils.js";

/** Marker rendered in place of a demoted diagnostic's now-untrustworthy line. */
export const PAST_EOF_STALE_MARKER = "[stale — line past EOF, re-run to confirm]";

/** How many demoted cited lines a single record names before it stops. */
const MAX_LOGGED_PAST_EOF_LINES = 3;

interface LineCountCacheEntry {
	mtimeMs: number;
	lineCount: number;
}

/**
 * Request-local memo for {@link getCachedLineCount}. The CALLER owns its
 * lifetime: create one with {@link createLineCountCache} at the start of a
 * render pass, thread it through every gate call in that pass, then let it
 * fall out of scope. Never store one on a module, a singleton, or anything
 * that outlives a single pass — see the module doc comment.
 */
export type LineCountCache = Map<string, LineCountCacheEntry>;

/** One per render pass. Discard after the pass — do not cache the cache. */
export function createLineCountCache(): LineCountCache {
	return new Map();
}

/**
 * Line count matching the conventional `wc -l` reading (and what the #1641
 * forensic case means by "402 lines on disk"): count newline characters, plus
 * one more for a trailing partial line with no terminator. A file ending in
 * `\n` therefore reports the same count as its last real line, not one past
 * it — an empty file is 0, `"a\n"` is 1, `"a"` is also 1, `"a\nb"` is 2.
 */
function countLines(content: string): number {
	if (content.length === 0) return 0;
	let newlineCount = 0;
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10) newlineCount++;
	}
	const endsWithNewline = content.charCodeAt(content.length - 1) === 10;
	return endsWithNewline ? newlineCount : newlineCount + 1;
}

/**
 * On-disk line count for `filePath`, memoized in `cache` for the duration of
 * the caller's render pass and invalidated by mtime WITHIN that pass. Returns
 * `undefined` when the file cannot be stat'ed or read (deleted, unreadable,
 * permissions) — callers MUST treat `undefined` as "no verdict", not as
 * "zero lines" (the empty-result-must-distinguish-clean-from-errored screen).
 */
export function getCachedLineCount(
	filePath: string,
	cache: LineCountCache,
): number | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return undefined;
	}
	const cached = cache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.lineCount;
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
	const lineCount = countLines(content);
	cache.set(filePath, { mtimeMs: stat.mtimeMs, lineCount });
	return lineCount;
}

/** The minimal shape this gate needs from a rendered diagnostic. */
export interface PastEofDiagnosticLike {
	/** 1-based cited line, as stored on `WidgetDiagnostic`. */
	line?: number;
	/** Already-demoted marker, shared with sibling freshness gates. */
	stale?: boolean;
}

export interface PastEofGateResult<T> {
	diagnostics: T[];
	demotedCount: number;
}

/**
 * Demote (never drop) every diagnostic in `diagnostics` whose cited `line`
 * exceeds `filePath`'s CURRENT on-disk line count. Pure apart from the cached
 * stat/read in {@link getCachedLineCount} and the bounded `logLatency` call
 * emitted on a demotion — never throws, never mutates the input array.
 *
 * `resync`, when supplied, is invoked at most once per call, only when
 * something was demoted, and its own failure is swallowed — a resync is a
 * best-effort heal, not a correctness dependency of the gate.
 */
export function demotePastEofDiagnostics<T extends PastEofDiagnosticLike>(args: {
	/** Serving surface name as it appears in telemetry, e.g. `"lens_diagnostics"`. */
	store: string;
	cwd: string;
	filePath: string;
	diagnostics: readonly T[];
	/** Pass-scoped memo from {@link createLineCountCache} — never a shared/module cache. */
	lineCountCache: LineCountCache;
	resync?: (filePath: string) => void;
}): PastEofGateResult<T> {
	const { diagnostics } = args;
	if (diagnostics.length === 0) {
		return { diagnostics: [], demotedCount: 0 };
	}
	const lineCount = getCachedLineCount(args.filePath, args.lineCountCache);
	if (lineCount === undefined) {
		// Fail open: no verdict available for this file right now.
		return { diagnostics: [...diagnostics], demotedCount: 0 };
	}
	const demotedLines: number[] = [];
	const out = diagnostics.map((d) => {
		if (d.stale) return d; // already demoted by another gate — leave it be.
		if (typeof d.line === "number" && d.line > lineCount) {
			demotedLines.push(d.line);
			return { ...d, stale: true };
		}
		return d;
	});
	if (demotedLines.length === 0) {
		return { diagnostics: out, demotedCount: 0 };
	}
	logLatency({
		type: "phase",
		phase: "diagnostic_past_eof",
		filePath: args.cwd,
		durationMs: 0,
		metadata: {
			store: args.store,
			file: toProjectRelativePath(args.filePath, args.cwd),
			actualLineCount: lineCount,
			demotedCount: demotedLines.length,
			sampleCitedLines: demotedLines.slice(0, MAX_LOGGED_PAST_EOF_LINES),
		},
	});
	if (args.resync) {
		try {
			args.resync(args.filePath);
		} catch {
			// Best-effort — a resync failure must never fail the render path.
		}
	}
	return { diagnostics: out, demotedCount: demotedLines.length };
}

/**
 * Default resync trigger (#1641 criterion 2): re-open the file with its
 * CURRENT disk content so the LSP's in-memory document is replaced rather
 * than left to re-publish the same divergent diagnostics next time
 * (`LSPService.openFile` sends a full-sync didChange, or a didClose/didOpen
 * pair for servers that only re-scan on a fresh open — see
 * `handleNotifyOpen`'s `reopenOnResync` branch). Dynamic import (mirrors
 * `clients/module-report-lsp.ts`) so this module — used from widget-state.ts
 * and tools/lens-diagnostics.ts — never statically depends on `clients/lsp`,
 * which itself imports widget-state.ts.
 *
 * Fire-and-forget by design: the caller is a synchronous render path and must
 * not block on (or fail because of) a resync. No LSP service, no client for
 * this file's language, or a transient read/spawn failure all degrade to a
 * silent no-op — the next successful touch/dispatch resyncs anyway.
 */
export function resyncDocumentOnPastEof(filePath: string): void {
	void (async () => {
		try {
			const [{ getLSPService }, content] = await Promise.all([
				import("./lsp/index.js"),
				fs.promises.readFile(filePath, "utf-8"),
			]);
			await getLSPService().openFile(filePath, content, {
				preserveDiagnostics: false,
			});
		} catch {
			// Best-effort heal only.
		}
	})();
}
