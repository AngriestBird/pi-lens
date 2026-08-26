export type FetchFn = (
	url: string,
	init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}>;

export type ClassificationKind = "real" | "infra-oom" | "infra-net";
export interface Classification {
	kind: ClassificationKind;
	detail: string;
}
export interface ClassifierMarker {
	sha: string;
	rerunTriggered: boolean;
}
export interface ClassifierDecision {
	classification: Classification;
	rerunTriggered: boolean;
	commentBody: string;
}

export declare function stripAnsi(text: string): string;
export declare function classifyFailureLog(rawLog: string): Classification;
export declare function buildMarker(
	sha: string,
	rerunTriggered: boolean,
): string;
export declare function parseClassifierMarker(
	commentBody: string | null | undefined,
): ClassifierMarker | null;
export declare function shouldTriggerRerun(args: {
	classification: Classification;
	sha: string;
	existingMarker: ClassifierMarker | null;
}): boolean;
export declare function buildCommentBody(args: {
	classification: Classification;
	sha: string;
	rerunTriggered: boolean;
}): string;
export declare function decideClassifierAction(args: {
	rawLog: string;
	sha: string;
	existingCommentBody: string | null | undefined;
}): ClassifierDecision;

export interface FetchedJob {
	sha: string;
	prNumber: number | null;
	jobId: number;
	jobName: string;
}
export declare function fetchRunAndFailedJob(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	runId: number | string;
	jobName?: string;
}): Promise<FetchedJob>;
export declare function fetchJobLog(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	jobId: number;
}): Promise<string>;
export declare function findExistingClassifierComment(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	prNumber: number;
}): Promise<{ id: number; body: string } | null>;
export declare function upsertComment(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	prNumber: number;
	existingComment: { id: number; body: string } | null;
	body: string;
}): Promise<unknown>;
export declare function triggerRerunFailedJobs(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	runId: number | string;
}): Promise<void>;
export declare function runClassifier(args: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	runId: number | string;
	jobName?: string;
	prNumber?: number;
}): Promise<
	ClassifierDecision & {
		sha: string;
		prNumber: number;
		jobId: number;
		jobName: string;
	}
>;
