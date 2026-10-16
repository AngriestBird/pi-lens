export const MAX_DROP_FRACTION: number;
export const EVALUATED_DIR_ENV: string;

export interface EvaluatedRecord {
	producer: string;
	evaluated: number;
	floor: number;
	prevEvaluated: number | null;
	ok: boolean;
	reason: string;
}

export interface EvaluatedProducer {
	floor: number;
	doc?: { path: string; floor: number; count(text: string): number | null };
}

export const EVALUATED_PRODUCERS: Record<string, EvaluatedProducer>;

export function assertEvaluated(input: {
	producer: string;
	evaluated: number;
	expectedAtLeast: number;
	previous?: number | null;
}): EvaluatedRecord;

export function missingRecord(
	producer: string,
	floor: number,
	previous?: number | null,
): EvaluatedRecord;

export function writeEvaluatedRecord(input: {
	producer: string;
	evaluated: number;
}): void;

export function readEvaluatedRecord(
	dir: string,
	producer: string,
): number | null;
