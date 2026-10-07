export declare const SOURCES: readonly [
	"issue",
	"fallback-no-issue",
	"fallback-bad-sha",
];
export declare function markerOf(sha: string): string;
export declare function parseLastReportSha(
	issues: Array<{ title: string; body?: string }>,
	title: string,
): string | null;
export declare function pickBase(options: {
	issues: Array<{ title: string; body?: string }>;
	title: string;
	isAncestor: (sha: string) => boolean;
	fallbackBase: () => string;
}): { base: string; source: (typeof SOURCES)[number] };
export declare function incompleteReasons(report: unknown): string[];
export declare function buildNightlyBody(options: {
	base: string;
	head: string;
	source: string;
	status: "ok" | "failed";
	report?: unknown;
	runUrl?: string;
}): string;
export declare function main(
	argv?: string[],
	cwd?: string,
): { base: string; source: (typeof SOURCES)[number] } | string;
