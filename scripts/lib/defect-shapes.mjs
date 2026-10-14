// The AGENTS.md "Recurring defect shapes" catalog, parsed once (#4439). The PR
// body Detection lint (`Shape:` / `Enforcer:`) and the catalog-to-HISTORY.md
// governance test both read it here, so neither carries a private parser.

/**
 * Blank HTML comments and fenced blocks IN PLACE: every non-newline character
 * becomes a space, so offsets and line numbers still line up with the raw text.
 * A reference quoted in a comment or an example never counts as real content.
 */
export function blankMarkdown(text) {
	const blank = (value) => value.replace(/[^\n]/g, " ");
	return String(text ?? "")
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, blank);
}

const CATALOG_HEADING = /^## Recurring defect shapes[ \t]*$/m;

/**
 * Map of shape number to the entry's text (the numbered line and its indented
 * continuation, comment-blanked). An entry ends at the first later line that is
 * not blank and not indented: the next shape, a `###` heading or a block tag.
 * Empty when the catalog heading is absent.
 */
export function parseDefectShapes(agentsMarkdown) {
	const blanked = blankMarkdown(agentsMarkdown);
	const start = blanked.search(CATALOG_HEADING);
	if (start < 0) return new Map();
	const rest = blanked.slice(start + 1);
	const end = rest.search(/^## /m);
	const lines = (end < 0 ? rest : rest.slice(0, end)).split(/\r?\n/);
	const shapes = new Map();
	let current = null;
	for (const line of lines) {
		const head = /^(\d+)\. \*\*/.exec(line);
		if (head) {
			current = { number: Number(head[1]), lines: [line] };
			shapes.set(current.number, current);
		} else if (current && (line.trim() === "" || /^\s/.test(line)))
			current.lines.push(line);
		else current = null;
	}
	return new Map(
		[...shapes].map(([number, entry]) => [number, entry.lines.join("\n")]),
	);
}

/** Issue and PR numbers in `text`: `#N` and `/issues|pull/N` URLs. */
export function issueNumbers(text) {
	return new Set(
		[...String(text ?? "").matchAll(/#(\d+)|\/(?:issues|pull)\/(\d+)/g)].map(
			(match) => Number(match[1] ?? match[2]),
		),
	);
}
