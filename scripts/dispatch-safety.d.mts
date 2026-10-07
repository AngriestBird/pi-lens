export declare const REPOSITORY_DEFAULT_PERMISSIONS: string;
export declare const WRITE_SCOPES: Set<string>;
export declare function effectivePermissions(
	workflowPermissions: unknown,
	jobPermissions: unknown,
): Record<string, unknown>;
export declare function writeScopes(
	permissions: Record<string, unknown>,
): string[];
export declare function workflowDocument(
	source: string,
): Record<string, unknown>;
export type DispatchableJob = {
	id: string;
	name: string;
	job: { if?: unknown; steps?: Array<{ if?: unknown }> };
	permissions: Record<string, unknown>;
	writeScopes: string[];
};
export declare function dispatchableJobs(
	source: string,
	workflowPath?: string,
): DispatchableJob[];
export declare function hasWriteToken(job: DispatchableJob): boolean;
export declare function guardSkipsOnRef(
	job: DispatchableJob,
	ref: string,
): boolean;
export declare function writerSteps(job: DispatchableJob): string[];
