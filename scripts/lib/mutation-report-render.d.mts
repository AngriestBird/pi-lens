export declare function renderMutationMarkdown(report: unknown): string;
export declare function formatTestSelection(selection: {
	pool: number;
	covering: number | null;
	kept: number;
	own?: number;
	unknown?: number;
}): string;
