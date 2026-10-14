import type { ExecVitest, ShuffleRun } from "./ci-shuffle-changed-tests.mjs";

export declare const CENSUS_SEEDS: readonly number[];
export declare const CHUNK_FILES: number;
export declare const START_CAP_MS: number;
export declare const MIN_START_MS: number;
export declare const RATCHET_PATH: string;
export type Seed = number | "alone";
export interface CensusRun extends ShuffleRun {
	kind: "census" | "confirm";
}
export interface Member {
	file: string;
	test: string;
	firstError: string;
}
export interface CensusRecord {
	key: string;
	kind: "census" | "confirm";
	label: string;
	files: string[];
	seed: Seed;
	verdict: "ok" | "red" | "timeout" | "uncollected";
	at?: number;
	ms: number;
	members: Member[];
	tail?: string;
}
export interface RatchetEntry {
	file: string;
	seed: number;
	test: string;
	seam: string;
}
export declare function listTestFiles(cwd: string): string[];
export declare function seedOf(run: { flags: string[] }): Seed;
export declare function planCensus(
	files: string[],
	options?: { seeds?: readonly number[]; chunk?: number },
): CensusRun[];
export declare function extractMembers(output: string): Member[];
export declare function loadRecords(dir: string): CensusRecord[];
export declare function isUnproven(record: CensusRecord): boolean;
export declare function runCensus(
	plan: CensusRun[],
	options: {
		cwd: string;
		outFile: string;
		done: Set<string>;
		budgetMs: number;
		exec?: ExecVitest;
		now?: () => number;
		log?: (line: string) => void;
	},
): { ran: number; pending: number };
export declare function planConfirms(records: CensusRecord[]): CensusRun[];
export declare function judgeCensus(state: {
	records: CensusRecord[];
	ratchet: Array<{ file: string; seed: Seed; test: string }>;
}): {
	code: 0 | 1 | 3;
	kind: "clean" | "red" | "unproven";
	members: Array<Member & { seed: Seed }>;
	lines: string[];
};
export declare function parseArgs(argv: string[]): {
	out: string;
	part: [number, number];
	chunk: number;
	budgetMs: number;
	seeds: number[];
	files: string[] | null;
	confirm: boolean;
	report: boolean;
	redoUnproven: boolean;
	ratchet: string;
	cwd: string;
};
export declare function run(
	argv: string[],
	io?: {
		exec?: ExecVitest;
		now?: () => number;
		log?: (line: string) => void;
	},
): number;
