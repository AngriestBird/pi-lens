import { readFileSync } from "node:fs";
import { blankMarkdown as blankMarkdownShared } from "./lib/defect-shapes.mjs";

const MAX_WORDS = 30;
const FILLER_PATTERNS = [
	"simply",
	"just",
	"obviously",
	"basically",
	"in order to",
	"very",
	"really",
	"please",
];
const PASSIVE_RE =
	/\b(?:is|are|was|were|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/gi;
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|cf|mr|mrs|dr|no)\./i;

// Trailers, fences, comments and code spans come out first, so the prose
// rules read only text a reader sees. Fences, comments and code spans are the
// shared lexer's (`blankMarkdown`), not a second copy (#4717: this masker
// treated any `<!--` as an opener, so a body quoting the syntax skipped every
// later section of prose instead of judging it).
function blankMarkdown(text) {
	const raw = String(text ?? "").split(/\r?\n/);
	const trailerPattern =
		/^\s*(?:Co-Authored-By|Signed-off-by|Refs|Closes):\s+/i;
	let lastContent = raw.length - 1;
	while (lastContent >= 0 && !raw[lastContent].trim()) lastContent -= 1;
	const trailerLines = new Set();
	for (let index = lastContent; index >= 0; index -= 1) {
		if (!raw[index].trim()) {
			trailerLines.add(index);
			continue;
		}
		if (!trailerPattern.test(raw[index])) break;
		trailerLines.add(index);
	}
	// The line filters read the line as written; the prose rules read it with
	// its code spans blanked, so a line opening with one is not taken for a
	// stack frame (`at …`) or a command.
	const masked = blankMarkdownShared(String(text ?? ""), {
		indentedCode: false,
		codeSpans: true,
	}).split(/\r?\n/);
	return blankMarkdownShared(String(text ?? ""), { indentedCode: false })
		.split(/\r?\n/)
		.map((line, lineIndex) => {
			if (trailerLines.has(lineIndex)) return "";
			if (/^\s*🤖 Generated with \[Claude Code\]\([^)]*\)\s*$/u.test(line))
				return "";
			if (/^\s*>/.test(line) || /^\s*\|/.test(line)) return "";
			if (
				/^\s*(?:\$\s|npm\s|yarn\s|pnpm\s|(?:FAIL|PASS|Tests:|Test Files:|AssertionError|Error:|at\s))/.test(
					line,
				)
			)
				return "";
			return masked[lineIndex]
				.replace(/https?:\/\/\S+/gi, " ")
				.replace(/(^|\s)(?:["'])([^"']+)(?:["'])(?=\s|$)/g, "$1 ");
		})
		.join("\n");
}

function isHeading(line) {
	return /^\s*#{1,6}\s+(.+?)\s*$/.exec(line);
}

function sentenceEnd(text, index) {
	const char = text[index];
	if (!".!?".includes(char) || /[.!?]/.test(text[index - 1] ?? ""))
		return false;
	const next = text[index + 1] ?? "";
	if (next && !/\s/.test(next)) return false;
	const before = text.slice(Math.max(0, index - 8), index + 1);
	if (char === "." && (ABBREVIATIONS.test(before) || /\b\d+$/.test(before)))
		return false;
	return true;
}

function splitSentences(text) {
	const sentences = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (!sentenceEnd(text, index)) continue;
		sentences.push(text.slice(start, index + 1));
		start = index + 1;
	}
	if (text.slice(start).trim()) sentences.push(text.slice(start));
	return sentences;
}

function wordCount(text) {
	return (text.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’/-]*\b/gu) ?? []).length;
}

function finding(rule, message, line) {
	return `${rule}${line ? ` (line ${line})` : ""}: ${message}`;
}

function proseLines(text) {
	return blankMarkdown(text).split("\n");
}

export function checkProse(text = "", options = {}) {
	const mode = options.mode ?? "block";
	const errors = [];
	const warnings = [];
	const lines = proseLines(text);
	const addBlock = (message) => {
		(mode === "warn" ? warnings : errors).push(message);
	};
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index];
		const heading = isHeading(raw);
		if (heading) {
			// A blanked code span keeps its width; the quote reads as one space.
			const title = heading[1].trim().replace(/\s+/g, " ");
			if (
				/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(title) ||
				/\b(?:WHY|SUMMARY|NOTES|TESTS)\b/.test(title)
			)
				addBlock(
					finding("heading-case", `use sentence case in "${title}"`, index + 1),
				);
			continue;
		}
		const source = raw.trim();
		if (!source) continue;
		const listMarker = source.match(/^\s*(?:[-*+]|\d+[.)])\s+/);
		const units = listMarker
			? splitSentences(source.slice(listMarker[0].length))
			: splitSentences(source);
		for (const unit of units) {
			if (wordCount(unit) > MAX_WORDS)
				addBlock(
					finding(
						"sentence-length",
						`use ${MAX_WORDS} words or fewer (found ${wordCount(unit)})`,
						index + 1,
					),
				);
		}
		for (const filler of FILLER_PATTERNS) {
			if (
				new RegExp(`\\b${filler.replaceAll(" ", "\\s+")}\\b`, "i").test(source)
			)
				addBlock(finding("filler", `remove "${filler}"`, index + 1));
		}
		for (const match of source.matchAll(PASSIVE_RE))
			warnings.push(
				finding(
					"passive-voice",
					`prefer active voice near "${match[0].replace(/\s+/g, " ")}"`,
					index + 1,
				),
			);
	}
	return { valid: errors.length === 0, errors, warnings };
}

export function proseSections(body = "") {
	const lines = String(body ?? "").split(/\r?\n/);
	const wanted = new Set(["why", "notes for the reviewer", "summary"]);
	const sections = [];
	let current = null;
	for (const line of lines) {
		const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line);
		if (heading) {
			if (current) sections.push(current);
			current = wanted.has(heading[1].trim().toLowerCase()) ? [line] : null;
		} else if (current) current.push(line);
	}
	if (current) sections.push(current);
	return sections.map((section) => section.join("\n")).join("\n\n");
}

export { FILLER_PATTERNS };

if (process.argv[1] && process.argv[1].endsWith("check-prose.mjs")) {
	const fileIndex = process.argv.indexOf("--body-file");
	const json = process.argv.includes("--json");
	const input =
		fileIndex === -1
			? readFileSync(0, "utf8")
			: readFileSync(process.argv[fileIndex + 1], "utf8");
	const result = checkProse(input);
	if (json) console.log(JSON.stringify(result));
	else {
		for (const error of result.errors) console.error(error);
		for (const warning of result.warnings) console.warn(`warning: ${warning}`);
	}
	process.exitCode = result.valid ? 0 : 1;
}
