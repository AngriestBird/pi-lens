export declare function stripLogDecorations(log: string): string;
export declare function extractFailingTestIds(log: string): string[];
export declare function compareFailureSets(
	previous: string[],
	current: string[],
): {
	fixed: string[];
	newFailures: string[];
	unchanged: string[];
};
export declare function parseArgs(argv: string[]): {
	jobA: string;
	jobB: string;
	repository: string;
};
export declare function main(argv?: string[]): number;
