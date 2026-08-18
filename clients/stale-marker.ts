/**
 * #1622 / #1419 precedent: what a demoted finding shows where its cached line
 * number used to be. The finding survives, the untrustworthy coordinate does not.
 *
 * #1631 review V2: lives in its own leaf module rather than `runtime-turn.ts`
 * (the turn orchestrator) so a low-level store like `widget-state.ts` can use
 * the marker without importing a high-level orchestration module — `madge
 * --circular` went from 0 to 45 cycles when `widget-state.ts` imported this
 * constant from `runtime-turn.ts`, and this repo ships that circular-import
 * check as a product feature. Both `runtime-turn.ts` and `widget-state.ts`
 * import it from here.
 */
export const STALE_LINE_MARKER = "[stale — re-run to confirm]";
