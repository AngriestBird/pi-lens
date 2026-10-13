import type { Candidate } from "./lib/stryker-pertest.mjs";

export declare function main(
	argv?: string[],
):
	| { patched: number }
	| ReturnType<typeof import("./lib/stryker-pertest.mjs").planPertest>
	| { summary: Record<string, number>; candidates: Candidate[] };
