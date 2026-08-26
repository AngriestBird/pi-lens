import { logLatency } from "./latency-logger.js";

/**
 * The complete observability path for a concurrent secondary. It deliberately
 * emits one bind record only: secondary sessions skip every primary reset and
 * hydration phase.
 */
export function logConcurrentSessionBind(args: {
	secondaryCount: number;
	sessionReason?: string;
	sameCwd: boolean;
	/** #2129: which secondary shape this was — `concurrent-secondary` (a live
	 *  sibling session) or `secondary-root` (a start in a different project
	 *  root). Optional so older callers/tests keep compiling. */
	classification?: string;
	/** #2129: the root-identity input the classifier consulted. `undefined`
	 *  means the comparison had nothing to compare, NOT "same root". */
	sameRoot?: boolean;
	/** #2129: the registered primary's normalized root at decision time. */
	primaryRoot?: string;
}): void {
	logLatency({
		type: "phase",
		filePath: "<pi-lens>",
		phase: "concurrent_session_bind",
		durationMs: 0,
		metadata: args,
	});
}
