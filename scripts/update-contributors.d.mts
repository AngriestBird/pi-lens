export declare function isBot(login: string): boolean;
export declare function classifyFiles(paths: string[]): string[];
export declare function classifyIssue(issue: {
	title?: string;
	labels?: unknown[];
}): "bug" | "ideas" | null;
export declare function planContributions(input: {
	prs: { number: number; author?: { login: string } }[];
	issues: {
		number: number;
		title: string;
		author?: { login: string };
		labels: unknown[];
	}[];
	filesByPr: Record<number, string[]>;
	existing: Record<string, string[]>;
	owner: string;
}): {
	login: string;
	isNew: boolean;
	add: string[];
	evidence: Record<string, number[]>;
}[];
export declare function formatPlan(
	plan: ReturnType<typeof planContributions>,
): string;
