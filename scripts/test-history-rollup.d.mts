export const HISTORY_MAX_AGE_MS: number;
export const METADATA_FILENAME: string;
/** The repo-relative posix id a journal row's `file` carries (#3367). */
export function normalizeTestFile(name: string): string;
export interface JournalRow {
	headSha: string;
	runId: string;
	file: string;
	outcome: string;
	durationMs: number;
	lane: string;
	/** Absent on rows written before #3447. */
	runAttempt?: string;
	recordedAt: string;
}
/** Compat read: parses journal text, normalizing pre-#3367 absolute paths. */
export function parseJournal(text: string): JournalRow[];
export function rowsFromArtifacts(inputs: string[]): Array<{
	headSha: string;
	runId: string;
	file: string;
	outcome: string;
	durationMs: number;
	lane: string;
	/** Absent on artifacts written before #3447. */
	runAttempt?: string;
	recordedAt: string;
}>;
export function rollupTestHistory(options: {
	artifactPaths: string[];
	historyPath: string;
	summaryPath: string;
	now?: number;
}): {
	rowCount: number;
	files: unknown[];
	flakeCandidates: Array<{ file: string; headSha: string }>;
	/** One row per failing (file, head); `flake` when the head also passed it. */
	failures: Array<{ file: string; headSha: string; flake: boolean }>;
	/** ISO time of this rollup: the history selector's staleness clock. */
	generatedAt: string;
};
export function runCli(argv: string[]): number;
