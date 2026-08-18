/**
 * Provenance metadata for the heavyweight project analyzers surfaced in
 * `lens_diagnostics mode=full`.
 *
 * NOTE (#585 regression cleanup): this module USED to also own
 * `extractCachedProjectDiagnostics` — a CACHE-ONLY reader that adapted each
 * analyzer's cached result to `ProjectDiagnostic[]` via a parallel `EXTRACTORS`
 * registry. #585 replaced that reader in production with
 * `fetchFreshProjectDiagnostics` (./fresh-fetch.ts), which triggers-or-joins a
 * fresh run instead of settling for a possibly-hours-stale session_start
 * snapshot. The old reader lingered here wired only to a test — a SECOND,
 * dead surfacing path whose registry could (and did) silently diverge from
 * fresh-fetch's `ANALYZER_IDS`: opengrep was registered here but missing there,
 * so opengrep scanned+cached yet never reached the agent (the exact #585-class
 * regression this cleanup removes). The parallel registry is gone; fresh-fetch
 * is the single source of truth (#883).
 *
 * What survives is the honesty metadata (#533): given an analyzer id that
 * fresh-fetch reported `cold` (not applicable / unavailable this run),
 * `warmTriggerFor` names what WOULD warm it, so the rendered note is actionable
 * rather than a bare "not run".
 */

export interface FailedProjectAnalyzer {
	id: string;
	summary: string;
}

/**
 * #533: which trigger warms each analyzer, surfaced in the "cold" honesty note
 * so the note is actionable (names what to do), matching the #511/#514 house
 * shape. Keyed by the ids `fetchFreshProjectDiagnostics` (./fresh-fetch.ts)
 * reports in its `cold` list — keep in sync with that module's `ANALYZER_IDS`.
 */
const WARM_TRIGGER: Record<string, string> = {
	knip: "runs at session-start",
	jscpd: "runs at session-start",
	madge: "runs at session-start",
	gitleaks:
		"runs at session-start (config opt-in), or on any git repo via mode=full (#608)",
	govulncheck: "runs at session-start (Go projects only)",
	opengrep: "runs at session-start",
	trivy: "runs at session-start",
	"dead-code": "runs at session-start (Python projects only)",
	"test-runner":
		"fires per-edit at turn_end (only after a source file with a discoverable test companion is edited)",
};

export function warmTriggerFor(analyzerId: string): string {
	return WARM_TRIGGER[analyzerId] ?? "runs at session-start";
}

/**
 * #1623: single formatter for a "not run" lane entry — reused by every
 * caller that renders `fetchFreshProjectDiagnostics`'s `cold` list (today,
 * `tools/lens-diagnostics.ts`'s mode=full) so the wording can't drift
 * per-caller. Prefers the SPECIFIC reason captured at the decision point
 * (`coldReasons`, ./fresh-fetch.ts) over the generic `warmTriggerFor` guess —
 * the latter only remains a fallback for a `cold` id this map doesn't cover.
 */
export function formatNotRunEntry(
	analyzerId: string,
	coldReasons: Record<string, string> | undefined,
): string {
	const reason = coldReasons?.[analyzerId];
	return reason
		? `${analyzerId} — not run (${reason})`
		: `${analyzerId} — not run (${warmTriggerFor(analyzerId)})`;
}

/**
 * #1623: human-readable age, for a lane whose result was served from cache
 * rather than executed fresh this call (see `cachedAgeMs`, ./fresh-fetch.ts).
 * Mirrors the granularity an agent actually needs to judge staleness — exact
 * seconds don't matter, "12m" vs "3h" does.
 */
export function formatCacheAge(ms: number): string {
	if (ms < 0) return "0m";
	const totalMinutes = Math.round(ms / 60_000);
	if (totalMinutes < 1) return "under 1m";
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}
