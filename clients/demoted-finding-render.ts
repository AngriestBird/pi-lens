/**
 * Body degradation for a DEMOTED finding (#1944).
 *
 * The demotion gates (#1631 dependency-drift, #1641 past-EOF) move a record
 * out of the authoritative blocker channel and into the advisory channel.
 * Until this module existed they changed the CHANNEL and nothing else: the
 * advisory embedded the blocker body verbatim, so the agent still read
 * "🔴 STOP — 11 issue(s) must be fixed" with dead line numbers under two
 * hedge lines it ignored. Live evidence (session 01a0234c, 2026-08-21): the
 * agent spent four re-run detours and about 7.4k tokens on a record whose
 * coordinates no longer existed, then explained an unrelated REAL blocker
 * away as "mid-edit state" in the same session.
 *
 * The rule this module owns, once, for every gated surface: a demoted body
 * loses its authority vocabulary and its dead coordinates, and it says so in
 * its own words. `clients/finding-delivery-gate.ts` documents the surrounding
 * contract; this is the one implementation of its "Demotion rendering" arm
 * for surfaces that carry a RENDERED BODY rather than a per-diagnostic row.
 * Per-row surfaces (`widget-state.ts`, `tools/lens-diagnostics.ts`) already
 * swap the coordinate for `PAST_EOF_STALE_MARKER` at render time and have no
 * body to degrade.
 *
 * Pure and leaf: no store, no coordinator, no I/O. The caller supplies the
 * dead lines it already computed while deciding to demote, so this module
 * never re-derives a verdict from rendered prose (the
 * re-derivation-vs-correlation screen).
 */

/** Suffix that replaces a cited coordinate the file no longer has. */
export const DEAD_LINE_ANNOTATION = "(line no longer exists)";

/**
 * Authority vocabulary a demoted body must not carry, with its degraded
 * replacement. Ordered: the full banner rewrite runs first so the narrower
 * fallbacks only ever see text the banner rule did not already cover.
 *
 * This table is the single source of truth for the rule. A surface must not
 * hand-roll its own "strip the STOP" pass — that is how #1631, #1641, and
 * #1664 each ended up with a different answer to the same question.
 */
const AUTHORITY_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/[^\S\n]*(?:🔴|⛔|❌)?[^\S\n]*STOP[^\S\n]*[—–-][^\S\n]*(\d+)[^\S\n]+issue\(s\)[^\S\n]+must be fixed:?/g,
		"$1 issue(s) were flagged before this file changed; the coordinates below may no longer exist:",
	],
	[/(?:🔴|⛔|❌)[^\S\n]*STOP\b[^\S\n]*[—–-]?/g, "Previously flagged —"],
	[/\bSTOP\b/g, "Previously flagged"],
	[/\bmust be fixed\b/g, "were flagged"],
];

export interface DegradedFindingBody {
	/** The degraded body. Safe to render under an advisory label. */
	body: string;
	/**
	 * How many authority markers this call rewrote. Zero is legitimate (a body
	 * that never carried a banner), so callers must not treat it as failure —
	 * it exists so a test can prove the rewrite actually fired.
	 */
	authorityMarkersRemoved: number;
	/** Cited lines annotated as no longer existing, in the order found. */
	deadLinesAnnotated: number[];
}

/** `  L310: message` / `L310 message` at the head of a rendered row. */
const CITED_LINE_RE = /^([^\S\n]*)L(\d+)\b/;

/**
 * Degrade one demoted finding's rendered body.
 *
 * Two independent transforms, deliberately separable so each can be proven by
 * its own test (and so deleting either one reds a different assertion):
 *
 *   1. Authority vocabulary: the STOP banner and the "must be fixed"
 *      imperative are rewritten to past-tense, non-directive wording.
 *   2. Dead coordinates: every cited `L<n>` whose line the file no longer has
 *      renders as `L<n> (line no longer exists)`. The message text stays —
 *      demote, never drop (#1419).
 */
export function degradeDemotedFindingBody(
	summary: string,
	options: { deadLines?: readonly number[] } = {},
): DegradedFindingBody {
	const deadLines = new Set(options.deadLines ?? []);
	let authorityMarkersRemoved = 0;

	let body = summary;
	for (const [pattern, replacement] of AUTHORITY_REWRITES) {
		body = body.replace(pattern, (...args) => {
			authorityMarkersRemoved += 1;
			// Expand `$n` against this match's capture groups by hand. A nested
			// `String.replace` with the SAME global regex would clobber the
			// outer call's `lastIndex` mid-iteration.
			return replacement.replace(/\$(\d)/g, (_, digit: string) =>
				String(args[Number(digit)] ?? ""),
			);
		});
	}

	const deadLinesAnnotated: number[] = [];
	if (deadLines.size > 0) {
		body = body
			.split("\n")
			.map((line) => {
				const hit = CITED_LINE_RE.exec(line);
				if (!hit) return line;
				const cited = Number.parseInt(hit[2] ?? "", 10);
				if (!Number.isFinite(cited) || !deadLines.has(cited)) return line;
				deadLinesAnnotated.push(cited);
				return `${hit[1] ?? ""}L${cited} ${DEAD_LINE_ANNOTATION}${line.slice(
					hit[0].length,
				)}`;
			})
			.join("\n");
	}

	return { body, authorityMarkersRemoved, deadLinesAnnotated };
}

/**
 * The one-line note a surface appends when it RETIRES a demoted finding after
 * its single degraded delivery. Rendered inside the advisory itself, so an
 * empty advisory section can only ever mean "nothing to say" — if something
 * was dropped, this line is in the payload (#1944 AC3).
 */
export function formatRetirementNote(deadLines: readonly number[]): string {
	const cited =
		deadLines.length > 0
			? ` (cited ${deadLines.length === 1 ? "line" : "lines"} ${deadLines.join(", ")})`
			: "";
	return (
		`Retired after this delivery${cited}: the file no longer has these lines, ` +
		"so this finding cannot be re-confirmed and will not be served again."
	);
}
