import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";

const LATENCY_LOG_DIR = getGlobalPiLensDir();
const LATENCY_LOG_FILE = path.join(LATENCY_LOG_DIR, "latency.log");

const writer = createNdjsonLogger({
	filePath: LATENCY_LOG_FILE,
	maxBytes: 10 * 1024 * 1024,
});

export interface LatencyEntry {
	type: "runner" | "tool_result" | "phase";
	/** ISO timestamp when this entry was written (= finish time for runners) */
	ts?: string;
	/** Process that wrote the entry; used to isolate current-session telemetry. */
	pid?: number;
	/** ISO timestamp when the runner/phase started — diff with ts = durationMs */
	startedAt?: string;
	toolName?: string;
	filePath: string;
	fullPath?: string;
	phase?: string;
	durationMs: number;
	totalDurationMs?: number;
	result?: string;
	runnerId?: string;
	status?: string;
	diagnosticCount?: number;
	semantic?: string;
	/** Per-diagnostic summary when a runner produces findings — aids root-cause analysis */
	diagnostics?: Array<{ rule?: string; message: string; line?: number; semantic?: string }>;
	/** For dispatch_complete: actual wall-clock time (groups run in parallel) */
	wallClockMs?: number;
	/** For dispatch_complete: sum of all individual runner durationMs */
	sumMs?: number;
	/** wallClockMs - sumMs ≥ 0 means parallelism saved this many ms */
	parallelGainMs?: number;
	metadata?: Record<string, unknown>;
}

export function logLatency(entry: LatencyEntry): void {
	if (isTestMode()) {
		return;
	}
	writer.log({ ...entry, ts: new Date().toISOString(), pid: process.pid });
}

export function getLatencyLogPath(): string {
	return LATENCY_LOG_FILE;
}

/** Resolve once all enqueued latency writes are on disk (tests/shutdown). */
export function flushLatencyLog(): Promise<void> {
	return writer.flush();
}

export function clearLatencyLog(): void {
	// Enqueue the truncate in the same serialized queue so a clear cannot race a
	// pending drain. Await flushLatencyLog() if you need the file empty on disk.
	writer.truncate();
}
