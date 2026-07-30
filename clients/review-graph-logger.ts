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
		| "persist_succeeded"
		| "persist_skipped"
		| "persist_failed";
	cwd: string;
	reason?: string;
	durationMs?: number;
	nodes?: number;
	edges?: number;
	elements?: number;
	cap?: number;
	error?: string;
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
