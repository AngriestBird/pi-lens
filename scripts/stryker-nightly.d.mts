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
export declare const MAX_PENDING: number;
export declare function parsePending(
	issues: Array<{ title: string; body?: string }>,
	title: string,
): { pending: string[]; pendingBase: string | null };
export declare function coverageGaps(report: unknown): {
	capped: string[];
	unfinished: string[];
};
export declare function nextQueue(options: {
	oldPending: string[];
	oldPendingBase: string | null;
	base: string;
	status: string;
	report?: unknown;
	exists: (file: string) => boolean;
}): {
	pending: string[];
	pendingBase: string | null;
	dropped: number;
	completed: boolean;
};
export declare function buildNightlyBody(options: {
	base: string;
	head: string;
	source: string;
	status: "ok" | "failed";
	report?: unknown;
	runUrl?: string;
	oldPending?: string[];
	oldPendingBase?: string | null;
	exists?: (file: string) => boolean;
}): string;
export declare function main(
	argv?: string[],
	cwd?: string,
):
	| {
			base: string;
			source: (typeof SOURCES)[number];
			pending: string[];
			pendingBase: string | null;
	  }
	| string;
