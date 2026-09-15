export declare const DEFAULT_MAX_FILES: 6;
export declare const MUTATION_VITEST_TEST_TIMEOUT_MS: 30000;
export declare const MUTATION_OUTPUT_MAX_BUFFER: 10485760;
export declare function capMutationFiles(
	files: string[],
	maxFiles?: number,
): { selected: string[]; skipped: string[] };
export declare function formatCapNotice(
	selectedCount: number,
	totalCount: number,
	skipped: string[],
): string;
export declare function formatVitestCommand(testFiles: string[]): string;
export declare function classifyStrykerFailure(
	output?: string,
): "dry-run-no-mutants-evaluated" | "stryker-failure";
export declare function formatStrykerFailure(result: {
	status?: number | null;
	error?: { message?: string } | null;
	stdout?: string | null;
	stderr?: string | null;
}): string;
export declare function strykerSpawnOptions(): {
	stdio: ["inherit", "pipe", "pipe"];
	encoding: "utf8";
	maxBuffer: 10485760;
};
export declare const isScriptMutationFile: (file: string) => boolean;
export declare function mapRelatedTests(
	changedFiles: string[],
	options?: {
		testFiles?: string[];
		readFile?: (file: string) => string;
	},
): {
	related: Map<string, Set<string>>;
	covered: string[];
	uncovered: string[];
	tests: string[];
};
