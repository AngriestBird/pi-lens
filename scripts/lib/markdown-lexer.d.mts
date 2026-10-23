export interface MarkdownRegionMode {
	code?: "blocks" | "fenced" | false;
	html?: "blocks" | "comments" | false;
	codeSpans?: boolean;
}
export function blankMarkdownRegions(
	text: string,
	mode: MarkdownRegionMode,
): string;
export interface MarkdownHeading {
	line: number;
	contentLine: number;
	depth: number;
	text: string;
}
export function markdownHeadings(text: string): MarkdownHeading[];
export function markdownBlockComments(text: string): number[];
