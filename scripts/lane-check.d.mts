export type LaneVerdict = "CAUSED-BY-CHANGE" | "RED-ON-BASE" | "INCONCLUSIVE";

export function classifyFailureFiles(
	files: string[],
	verdicts: Record<string, LaneVerdict>,
): Array<{ file: string; verdict: LaneVerdict }>;

export function laneExitCode(
	classifications: Array<{ verdict: LaneVerdict }>,
): 0 | 1;

export function main(argv?: string[]): number;
