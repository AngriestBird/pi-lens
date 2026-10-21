// The one CommonMark reader behind the repository's markdown gates (#4717).
//
// Every question "does the reader see this?" (is this a heading, is this a
// comment, is this code) is answered by `marked`'s lexer, never by a scan of
// our own: four review rounds on #4717 each found one more spelling a
// hand-written comment and code-span scanner missed. This module only places
// the lexer's own tokens back onto the source's offsets.
//
// `marked` is loaded lazily, on the first call, so a script that imports this
// module and never reads markdown structure (`scripts/check-close-keywords.mjs`
// in the `Close-keyword syntax` and `Verify merged PR close keywords` jobs,
// which run with no install) never resolves it. The `PR body (advisory)` job
// installs marked alone, pinned by the lockfile's integrity
// (`.github/workflows/pr-metadata.yml`). A missing install throws: a gate that
// cannot read the body must not read it as clean.
import { createRequire } from "node:module";

// A plain `require` binding, so knip sees the dependency; calling it stays
// lazy.
const require = createRequire(import.meta.url);
let lexMarkdown = null;

function lex(source) {
	if (!lexMarkdown) {
		const { Lexer, getDefaults } = require("marked");
		// A fresh defaults object, so a `marked.use()` elsewhere in the process
		// (pi-tui renders with marked) cannot change what the gate reads.
		lexMarkdown = (text) =>
			new Lexer({ ...getDefaults(), gfm: true }).lex(text);
	}
	return lexMarkdown(source);
}

/** `\r\n` and lone `\r` become `\n`, as the lexer reads them. */
function normalized(text) {
	return String(text ?? "").replace(/\r\n?/g, "\n");
}

/**
 * The top-level tokens with their offsets into the normalized source: the
 * tokens' raw text covers the source exactly, in order
 * (`tests/scripts/markdown-lexer.test.ts` pins it over every markdown file in
 * the repository, so a lexer upgrade that breaks it reds there).
 */
function topLevelBlocks(source) {
	const blocks = [];
	let offset = 0;
	for (const token of lex(source)) {
		blocks.push({ token, start: offset, end: offset + token.raw.length });
		offset += token.raw.length;
	}
	return blocks;
}

function children(token) {
	if (token.type === "list") return token.items;
	if (token.type === "table")
		return [...token.header, ...token.rows.flat()].flatMap(
			(cell) => cell.tokens ?? [],
		);
	return token.tokens ?? [];
}

function isComment(token) {
	return token.raw.startsWith("<!--");
}

/**
 * The comments inside a raw-HTML block's text, as the browser reads them
 * (the HTML tokenizer's comment states, not CommonMark's): `<!-->` and
 * `<!--->` end at once, any other comment at its first `-->` or `--!>`, and
 * one with no end runs to the end of the block. GitHub shows the rest of the
 * block, so a comment that ends mid-line leaves the line's tail visible
 * (#4565). Offsets are into `raw`.
 */
function commentRanges(raw) {
	const ranges = [];
	for (let at = raw.indexOf("<!--"); at !== -1;) {
		const open = at + 4;
		let end;
		if (raw.startsWith(">", open)) end = open + 1;
		else if (raw.startsWith("->", open)) end = open + 2;
		else {
			const close = /--!?>/g;
			close.lastIndex = open;
			const match = close.exec(raw);
			end = match ? match.index + match[0].length : raw.length;
		}
		ranges.push([at, end]);
		at = raw.indexOf("<!--", end);
	}
	return ranges;
}

// What a mode blanks. `code`: "blocks" (fenced and indented), "fenced"
// (indented code stays text) or false. `html`: "blocks" (every raw-HTML block
// and every inline comment), "comments" (the comments inside raw-HTML blocks,
// and inline comments) or false. `codeSpans`: true blanks inline code.
function isTarget(token, mode) {
	if (token.type === "code")
		return (
			mode.code === "blocks" ||
			(mode.code === "fenced" && token.codeBlockStyle !== "indented")
		);
	if (token.type === "html") {
		if (token.block)
			return (
				mode.html === "blocks" ||
				(mode.html === "comments" && token.raw.includes("<!--"))
			);
		return Boolean(mode.html) && isComment(token);
	}
	if (token.type === "codespan") return Boolean(mode.codeSpans);
	return false;
}

function containsTarget(token, mode) {
	return (
		isTarget(token, mode) ||
		children(token).some((child) => containsTarget(child, mode))
	);
}

/**
 * Place `raw` at or after `cursor` in `source`, line by line: a nested token's
 * raw text has its container's prefix (`> `, a list indent) removed, so each
 * of its lines is found on its own. Returns the spans, or null when a line is
 * not found (a table cell's `\|` reaches the lexer as `|`), and the caller
 * then blanks the whole block.
 */
function place(source, raw, cursor) {
	const spans = [];
	let at = cursor;
	for (const piece of raw.split("\n")) {
		if (!piece) continue;
		const index = source.indexOf(piece, at);
		if (index === -1) return null;
		spans.push([index, index + piece.length]);
		at = index + piece.length;
	}
	return { spans, end: at };
}

/**
 * The source spans a placed target hides: all of it, except a raw-HTML block
 * under `html: "comments"`, which hides only its comments. A raw range is
 * mapped through the placed lines (`raw`'s non-empty lines, in order).
 */
function hiddenSpans(token, mode, spans) {
	if (!(token.type === "html" && token.block && mode.html === "comments"))
		return spans;
	const lines = [];
	let offset = 0;
	for (const piece of token.raw.split("\n")) {
		if (piece) lines.push([offset, offset + piece.length]);
		offset += piece.length + 1;
	}
	const hidden = [];
	for (const [from, to] of commentRanges(token.raw))
		lines.forEach(([start, end], index) => {
			const low = Math.max(from, start);
			const high = Math.min(to, end);
			if (low < high)
				hidden.push([
					spans[index][0] + low - start,
					spans[index][0] + high - start,
				]);
		});
	return hidden;
}

/**
 * Mark every target inside one block; false when one holding a target cannot
 * be placed. Each token is placed before its children and the cursor then
 * moves past all of it, so text a token holds outside its children (a link's
 * destination) can never take a later token's place.
 */
function markInside(source, block, mode, mask) {
	let cursor = block.start;
	const visit = (token) => {
		const placed = place(source, token.raw ?? "", cursor);
		if (!placed) return !containsTarget(token, mode);
		if (isTarget(token, mode))
			for (const [from, to] of hiddenSpans(token, mode, placed.spans))
				mask.fill(1, from, to);
		else if (!children(token).every(visit)) return false;
		cursor = placed.end;
		return true;
	};
	return visit(block.token);
}

function markRegions(source, mode, mask) {
	for (const block of topLevelBlocks(source)) {
		if (!containsTarget(block.token, mode)) continue;
		if (!markInside(source, block, mode, mask))
			mask.fill(1, block.start, block.end);
	}
}

/**
 * `text` with the regions `mode` names replaced by spaces. Line breaks are
 * kept, and so is every other character, so line numbers and offsets still
 * match the input (`\r\n` included). Fail closed: a target the lexer reports
 * but this module cannot place blanks its whole top-level block.
 */
export function blankMarkdownRegions(text, mode) {
	const original = String(text ?? "");
	const source = normalized(original);
	const mask = new Uint8Array(source.length);
	markRegions(source, mode, mask);
	return restoreLineEnds(original, apply(source, mask));
}

function apply(source, mask) {
	let out = "";
	for (let index = 0; index < source.length; index += 1)
		out += mask[index] && source[index] !== "\n" ? " " : source[index];
	return out;
}

function restoreLineEnds(original, blanked) {
	if (!original.includes("\r")) return blanked;
	let out = "";
	let j = 0;
	for (let i = 0; i < original.length; i += 1, j += 1) {
		if (original[i] === "\r") {
			out += original[i + 1] === "\n" ? "\r\n" : "\r";
			if (original[i + 1] === "\n") i += 1;
			continue;
		}
		out += blanked[j];
	}
	return out;
}

/**
 * The top-level headings, as the reader sees them: a heading inside a list
 * item, a block quote, a raw-HTML block or a comment is not a section of the
 * document, so it is not here. `line` is the heading's first line and
 * `contentLine` the first line after it (a setext underline is part of the
 * heading), both 0-based over `text.split(/\r?\n/)`.
 */
export function markdownHeadings(text) {
	const source = normalized(text);
	const headings = [];
	for (const { token, start } of topLevelBlocks(source)) {
		if (token.type !== "heading") continue;
		const line = lineOf(source, start);
		headings.push({
			line,
			contentLine: line + token.raw.replace(/\n+$/, "").split("\n").length,
			depth: token.depth,
			text: token.text.trim(),
		});
	}
	return headings;
}

function lineOf(source, offset) {
	let line = 0;
	for (
		let index = source.indexOf("\n");
		index !== -1 && index < offset;
		index = source.indexOf("\n", index + 1)
	)
		line += 1;
	return line;
}
