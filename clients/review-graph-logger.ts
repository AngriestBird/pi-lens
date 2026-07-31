import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";

const REVIEW_GRAPH_LOG_DIR = getGlobalPiLensDir();
const REVIEW_GRAPH_LOG_FILE = path.join(
	REVIEW_GRAPH_LOG_DIR,
	"review-graph.log",
);

const writer = createNdjsonLogger({ filePath: REVIEW_GRAPH_LOG_FILE });

export interface ReviewGraphLogEntry {
	ts?: string;
	phase:
		| "build_started"
		| "build_succeeded"
		| "build_skipped"
		| "build_failed"
		| "lsp_symbol_fallback"
		| "persist_scheduled"
		| "persist_partial"
		| "persist_succeeded"
		| "persist_skipped"
		| "persist_failed"
		| "worker_fallback"
		// #936 limit 2: cross-session resumable full build (checkpointing).
		| "checkpoint_written"
		| "checkpoint_resumed";
	cwd: string;
	reason?: string;
	durationMs?: number;
	nodes?: number;
	edges?: number;
	elements?: number;
	persistedElements?: number;
	cap?: number;
	error?: string;
	rawBytes?: number;
	gzBytes?: number;
	serializeMs?: number;
	writeMs?: number;
	offloaded?: boolean;
	// #936: checkpoint telemetry (files processed / reused / re-walked / target).
	processed?: number;
	reused?: number;
	stale?: number;
	remaining?: number;
	target?: number;
}

export function logReviewGraph(entry: ReviewGraphLogEntry): void {
	if (isTestMode()) {
		return;
	}
	writer.log({ ts: new Date().toISOString(), ...entry });
}

export function getReviewGraphLogPath(): string {
	return REVIEW_GRAPH_LOG_FILE;
}

/** Resolve once all enqueued review-graph writes are on disk (tests/shutdown). */
export function flushReviewGraphLog(): Promise<void> {
	return writer.flush();
}

/** Teardown-only: force queued entries to disk before the process exits. */
export function flushReviewGraphLogSync(): void {
	writer.flushSync();
}
