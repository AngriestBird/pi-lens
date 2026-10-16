import type { EvaluatedRecord } from "./lib/assert-evaluated.mjs";

export function gitHeadText(docPath: string): string | null;
export function checkRecords(
	dir: string,
	headText?: (docPath: string) => string | null,
): EvaluatedRecord[];
export function checkDocs(
	root?: string,
	headText?: (docPath: string) => string | null,
): EvaluatedRecord[];
/** Exit code: 0 ok, 1 below a floor, 2 usage. */
export function main(argv: string[]): number;
