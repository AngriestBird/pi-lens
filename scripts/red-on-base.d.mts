export type TestRun = { passed: boolean; names: string[] };
export type Verdict = {
	verdict: "CAUSED-BY-CHANGE" | "RED-ON-BASE" | "ISOLATION-GREEN";
	failingNames: string[];
};
export function decideVerdict(runs: {
	head: TestRun;
	base: TestRun;
	isolation: TestRun;
}): Verdict;
export function main(argv?: string[]): number;
