export declare const P90_CAP_RATIO: number;

export interface RequiredJobSpec {
	key: string;
	name: string;
	display: string;
	matcher: RegExp;
	capMinutes: number | null;
}

export interface JobRow {
	name: string;
	started_at?: string | null;
	completed_at?: string | null;
	conclusion?: string | null;
}

export interface MasterRun {
	id: number;
	created_at: string;
	jobs: JobRow[];
}

export interface P90Warning {
	key: string;
	name: string;
	display: string;
	p90Seconds: number;
	capSeconds: number;
	ratio: number;
	samples: number;
	window: { runs: number; from: string; to: string };
}

export declare function requiredJobSpecs(workflow: {
	jobs?: Record<string, unknown>;
}): RequiredJobSpec[];
export declare function p90(values: number[]): number | undefined;
export declare function p90Warnings(input: {
	specs: RequiredJobSpec[];
	runs: MasterRun[];
	ratio?: number;
}): { warnings: P90Warning[]; skipped: Array<{ key: string; reason: string }> };
export declare function formatP90Warning(w: P90Warning): string;
