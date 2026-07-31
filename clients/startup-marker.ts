import { performance } from "node:perf_hooks";

/**
 * Earliest pi-lens evaluation marker. `index.ts` must import this module first
 * so host boot and pi-lens's own module-graph evaluation remain attributable.
 */
export const PI_LENS_EVAL_STARTED_MS = performance.now();
