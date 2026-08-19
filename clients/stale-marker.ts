/**
 * #1622 / #1419 precedent: what a demoted finding shows where its cached line
 * number used to be. The finding survives, the untrustworthy coordinate does
 * not. Shared base marker so every freshness gate (dependency-drift blockers,
 * cached-scanner staleness, #1641's past-EOF gate) renders the same "this
 * coordinate is no longer trustworthy" vocabulary — a caller with a more
 * specific reason appends its own suffix rather than inventing a parallel
 * marker string.
 */
export const STALE_LINE_MARKER = "[stale — re-run to confirm]";
