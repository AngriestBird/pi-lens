// Type declarations for check-snapshot-persist-ratio.mjs (#3916).

export const DRIFT_THRESHOLD: number;
export interface PersistRatio {
	workerMB: number;
	syncMB: number;
	ratio: number;
}
export interface RatioVerdict extends Partial<PersistRatio> {
	state: "clean" | "drift" | "error";
	threshold: number;
	reason?: string;
}
export function firstPersistRatio(report: unknown): PersistRatio;
export function evaluate(
	report: unknown,
	options?: { threshold?: number },
): RatioVerdict;
export function buildDriftBody(
	verdict: RatioVerdict,
	options?: { runUrl?: string; report?: { node?: string; platform?: string } },
): string;
export function main(argv?: string[], log?: (line: string) => void): number;
