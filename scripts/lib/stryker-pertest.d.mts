export declare const GOVERNANCE_TEST_PREFIX: string;
export declare function isGovernanceTest(file: string): boolean;
export declare function planPertest(
	moduleFile: string,
	options?: {
		testFiles?: string[];
		readFile?: (file: string) => string;
		exclusions?: Record<string, { reason?: string }>;
	},
): {
	module: string;
	target: string;
	tests: string[];
	excluded: Array<{ file: string; reason: string }>;
};
export declare function patchVitestRunner(runnerDir: string): {
	patched: number;
};
export type ReportMutant = {
	id: string;
	status: string;
	coveredBy?: string[];
	killedBy?: string[];
	static?: boolean;
};
export type MutationReport = {
	files: Record<string, { mutants: ReportMutant[] }>;
	testFiles?: Record<string, { tests: Array<{ id: string; name: string }> }>;
};
export type Candidate = {
	id: string;
	file: string;
	name: string;
	code: "covers-no-mutant" | "redundant" | "observes-nothing";
	reason: string;
	covers: number;
	kills: number;
	survivedCovered: number;
	killedByOthers: number;
};
export declare function findWorthlessTests(report: MutationReport): Candidate[];
export declare function summarizeReport(
	report: MutationReport,
): { total: number } & Record<string, number>;
export declare function renderCandidates(
	candidates: Candidate[],
	summary: Record<string, number>,
	meta?: { module?: string },
): string;
