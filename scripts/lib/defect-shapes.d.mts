export function blankMarkdown(
	text: string,
	options?: { indentedCode?: boolean },
): string;
export function parseDefectShapes(agentsMarkdown: string): Map<number, string>;
export function issueNumbers(text: string): Set<number>;
export declare const HEADING: RegExp;
export function sourceWithoutFencedBlocks(
	source: string,
	options?: { indentedCode?: boolean },
): string;
