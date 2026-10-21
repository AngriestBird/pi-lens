/**
 * Parse bash commands for the file access the agent performed, so the read-guard
 * stays consistent with how the Read/Write tools are tracked:
 *
 *   - VIEW commands (cat/head/tail/sed -n) → reads, recorded with the exact line
 *     range shown (like the Read tool's delivered range).
 *   - WRITE commands (redirects, tee, sed -i, cp/mv dest, touch, and explicit
 *     in-place formatter/fixer targets) → the agent
 *     authored/owns the resulting file, exactly like the Write tool — these are
 *     registered via noteCreatedFile + recordWritten so a follow-up edit is not
 *     blocked.
 *
 * NOT treated as reads: grep (scattered matches, not a contiguous view), find
 * and ls (names only, no content), and bare path mentions in arbitrary commands.
 * Treating those as reads would let an edit through for content never shown.
 */
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { isReadableSourceFile } from "./file-kinds.js";
import { normalizeHostToolPath } from "./path-utils.js";
import { classifyMutatingTool } from "./mutating-tool.js";
import { countFileLines } from "./read-guard-tool-lines.js";
import type { SearchReadLocation } from "./search-read-registration.js";
import { stripAnsi } from "./sanitize.js";

/** A contiguous range of lines a bash command showed the agent. */
export interface ReadSpan {
	filePath: string;
	/** 1-based first line read. */
	offset: number;
	/** Number of lines read. */
	limit: number;
}

function stripQuotes(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
			return token.slice(1, -1);
		}
	}
	return token;
}

/** Small conservative shell lexer shared by command-analysis consumers. */
export interface ShellCommandSegment {
	tokens: string[];
	unsupported: boolean;
	/**
	 * Set to "pipe" when this segment's output feeds the NEXT segment via an
	 * unquoted `|` (used by #1908 to detect a truncating pipe tail after
	 * grep). Undefined for every other terminator (`;`, `&&`, `||`, `&`, EOF)
	 * — those consumers don't need it and adding cases here is a no-op for
	 * them.
	 */
	terminator?: "pipe";
	/** Quoted-leading-tilde facts indexed by the token they came from. */
	quotedTilde?: readonly boolean[];
}

/**
 * How a segment ended. `redirect` is an `&` that belongs to a redirection
 * (`2>&1`, `>&2`, `&>f`), so the next segment is the same simple command; a
 * `|&` is a `pipe`; `end` is the end of the text.
 */
type ShellSegmentExit =
	| "and"
	| "or"
	| "pipe"
	| "seq"
	| "background"
	| "redirect"
	| "end";

/**
 * One lexed segment with its character range in the command text (`start` where
 * the previous terminator ended, `end` at this segment's own terminator). A
 * redirect target's offset falls in the range of the segment that runs it,
 * which is how `scanShellWriteScopes` decides which `cd` applies to it (#2050
 * AC4). Internal: the public segment shape callers compare stays unchanged.
 */
interface ShellSegmentRange {
	segment: ShellCommandSegment;
	start: number;
	end: number;
	exit: ShellSegmentExit;
	/** An unquoted `(`, `)`, `{`, `}` or backtick appeared in the segment. */
	grouping: boolean;
	/** Per token: a redirection's descriptor or target, not an argument. */
	redirectWords: readonly boolean[];
	/**
	 * Per token: the token is bash's own word after quote removal (#4713 R7-1).
	 * Admitted characters only: any character in single or double quotes,
	 * except a double-quoted escape bash does not remove; an escaped unquoted
	 * one; an unquoted one from `LITERAL_WORD_CHAR`; and an unquoted `~` that
	 * starts the word as `~` or `~/`. Any other character clears it. `$` and a
	 * backtick, which double quotes still expand, are refused later by
	 * `resolveCdOperand`, as for every directory a command names.
	 */
	literalWords: readonly boolean[];
	/**
	 * Per token: the length of its leading run of characters that came from no
	 * quotes and no removed escape (#4713 R8-3). The run ends at the first quote
	 * or escape in the SOURCE, even one that adds no character (`FOO""=bar`,
	 * #4713 R10). Bash reads `NAME=` as an assignment only when it lies inside
	 * that run. A backslash the token keeps (`\cd`) and the character after it
	 * count as part of the run: the token's text still shows it.
	 */
	unquotedLengths: readonly number[];
}

/**
 * An unquoted character bash takes as itself in a word. No `~`: bash expands
 * one after `=` (`a=~/x`), so only a leading one is admitted, and only as `~`
 * or `~/`, which `resolveCdOperand` expands.
 */
const LITERAL_WORD_CHAR = /^[A-Za-z0-9_./@%:,=+-]$/;

interface PendingHeredoc {
	delimiter: string;
	stripTabs: boolean;
	quoted: boolean;
}

function parseHeredocDelimiter(
	command: string,
	start: number,
): { heredoc: PendingHeredoc; end: number } | undefined {
	let i = start;
	const stripTabs = command[i] === "-";
	if (stripTabs) i += 1;
	while (/\s/.test(command[i] ?? "")) i += 1;
	let delimiter = "";
	let quoted = false;
	while (i < command.length && !/[\s;&|<>]/.test(command[i] ?? "")) {
		const ch = command[i];
		if (ch === "'" || ch === '"') {
			quoted = true;
			const quote = ch;
			i += 1;
			while (i < command.length && command[i] !== quote) {
				delimiter += command[i++];
			}
			if (command[i] !== quote) return undefined;
			i += 1;
			continue;
		}
		if (ch === "\\") {
			quoted = true;
			i += 1;
			if (i >= command.length) return undefined;
			delimiter += command[i++];
			continue;
		}
		delimiter += ch;
		i += 1;
	}
	if (!delimiter) return undefined;
	return { heredoc: { delimiter, stripTabs, quoted }, end: i - 1 };
}

function heredocSubstitutionBodies(body: string): string[] {
	const substitutions: string[] = [];
	for (let i = 0; i < body.length; i += 1) {
		if (body.startsWith("$(", i)) {
			let depth = 1;
			let quote: "single" | "double" | undefined;
			for (let end = i + 2; end < body.length; end += 1) {
				const ch = body[end];
				if (quote === "single") {
					if (ch === "'") quote = undefined;
					continue;
				}
				if (quote === "double") {
					if (ch === '"' && body[end - 1] !== "\\") quote = undefined;
					continue;
				}
				if (ch === "'" || ch === '"') {
					quote = ch === "'" ? "single" : "double";
				} else if (body.startsWith("$(", end)) {
					depth += 1;
					end += 1;
				} else if (ch === ")") {
					depth -= 1;
					if (depth === 0) {
						substitutions.push(body.slice(i + 2, end));
						i = end;
						break;
					}
				}
			}
		} else if (body[i] === "`" && body[i - 1] !== "\\") {
			const end = body.indexOf("`", i + 1);
			if (end >= 0) {
				substitutions.push(body.slice(i + 1, end));
				i = end;
			}
		}
	}
	return substitutions;
}

function consumeHeredocBodies(
	command: string,
	start: number,
	heredocs: PendingHeredoc[],
): { end: number; substitutions: string[] } {
	let cursor = start;
	const substitutions: string[] = [];
	for (const heredoc of heredocs) {
		const bodyStart = cursor;
		let found = false;
		while (cursor < command.length) {
			const lineEnd = command.indexOf("\n", cursor);
			const end = lineEnd < 0 ? command.length : lineEnd;
			let line = command.slice(cursor, end);
			if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
			if (line.replace(/\r$/, "") === heredoc.delimiter) {
				if (!heredoc.quoted)
					substitutions.push(
						...heredocSubstitutionBodies(command.slice(bodyStart, cursor)),
					);
				cursor = lineEnd < 0 ? end : end + 1;
				found = true;
				break;
			}
			cursor = lineEnd < 0 ? end : end + 1;
		}
		if (!found) {
			if (!heredoc.quoted)
				substitutions.push(
					...heredocSubstitutionBodies(command.slice(bodyStart)),
				);
			return { end: command.length - 1, substitutions };
		}
	}
	return { end: cursor - 1, substitutions };
}

interface ShellOperand {
	text: string;
	quotedTilde: boolean;
}

function shellOperands(segment: ShellCommandSegment): ShellOperand[] {
	return segment.tokens.map((text, index) => ({
		text,
		quotedTilde: segment.quotedTilde?.[index] === true,
	}));
}

export function tokenizeShellCommand(command: string): ShellCommandSegment[] {
	return tokenizeShellCommandWithRanges(command).map((entry) => entry.segment);
}

function tokenizeShellCommandWithRanges(command: string): ShellSegmentRange[] {
	const segments: ShellSegmentRange[] = [];
	const pendingHeredocs: PendingHeredoc[] = [];
	let tokens: string[] = [];
	let word = "";
	/**
	 * How many leading characters of the word came out of no quotes and no
	 * escape, before the first quote or escape in its source. A leading tilde
	 * outside that run is literal to bash (`'~/x'`, `"~/x"`, `""~/x`,
	 * `~""/x`) rather than a home prefix (#4577 M1). Reset with the word.
	 */
	let wordUnquoted = 0;
	// False once the word's source met a quote or an escape (#4713 R10).
	let wordRunOpen = true;
	let quotedTilde: boolean[] = [];
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let unsupported = false;
	let atTokenStart = true;
	let segmentStart = 0;
	let grouping = false;
	let redirectWords: boolean[] = [];
	// The next word is a redirection's target (`> f`, `2>&1`'s `1`).
	let redirectPending = false;
	let literalWords: boolean[] = [];
	let unquotedLengths: number[] = [];
	let wordLiteral = true;
	const appendChar = (
		ch: string | undefined,
		quoted: boolean,
		literal: boolean,
	) => {
		if (quoted) wordRunOpen = false;
		else if (wordRunOpen) wordUnquoted += (ch ?? "").length;
		word += ch ?? "";
		if (!literal) wordLiteral = false;
	};
	const flushWord = () => {
		if (word) {
			// Bash expands a leading `~` only when its tilde-prefix, up to the
			// first `/`, lies in the unquoted run (`~""/x` stays literal; #4577
			// M1, #4713 R10).
			const slash = word.indexOf("/");
			const tildeExpands =
				word.startsWith("~") &&
				(wordRunOpen || (slash >= 0 && wordUnquoted > slash));
			quotedTilde.push(word.startsWith("~") && !tildeExpands);
			tokens.push(word);
			redirectWords.push(redirectPending);
			redirectPending = false;
			const expandedTilde =
				tildeExpands && word !== "~" && !word.startsWith("~/");
			literalWords.push(wordLiteral && !expandedTilde);
			unquotedLengths.push(wordUnquoted);
		}
		word = "";
		wordUnquoted = 0;
		wordRunOpen = true;
		wordLiteral = true;
		atTokenStart = true;
	};
	const flushSegment = (
		terminator?: "pipe",
		end = command.length - 1,
		exit: ShellSegmentExit = "end",
	) => {
		flushWord();
		if (tokens.length > 0 || unsupported)
			segments.push({
				segment: {
					tokens,
					unsupported,
					terminator,
					...(quotedTilde.some(Boolean) ? { quotedTilde } : {}),
				},
				start: segmentStart,
				end,
				exit,
				grouping,
				redirectWords,
				literalWords,
				unquotedLengths,
			});
		tokens = [];
		quotedTilde = [];
		redirectWords = [];
		literalWords = [];
		unquotedLengths = [];
		grouping = false;
		unsupported = false;
		atTokenStart = true;
		segmentStart = end + 1;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (quote === "single") {
			if (ch === "'") quote = undefined;
			else appendChar(ch, true, true);
			continue;
		}
		if (quote === "double") {
			if (escaped) {
				// Bash unescapes only these inside double quotes; elsewhere it keeps
				// the backslash this drops.
				appendChar(ch, true, ch !== undefined && '$`"\\'.includes(ch));
				escaped = false;
			} else if (ch === "\\") escaped = true;
			else if (ch === '"') quote = undefined;
			else appendChar(ch, true, true);
			continue;
		}
		if (escaped) {
			// A backslash-newline is a shell line continuation, not part of the
			// command argument. Keeping the newline here makes a continued git command
			// visible to command guards.
			if (ch !== "\n") appendChar(ch, true, true);
			escaped = false;
			atTokenStart = false;
			continue;
		}
		if (ch === "\\") {
			// Bash uses backslash as a general escape, but command inputs on
			// Windows routinely contain native paths (C:\\src\\file.ts). Preserve
			// backslashes before ordinary path characters while still honoring
			// shell escapes and line continuations.
			if (next === "\n" || /[\s\\'";$|&<>]/.test(next ?? "")) {
				escaped = true;
			} else {
				// Bash removes this backslash; the token keeps it.
				appendChar(ch, false, false);
				atTokenStart = false;
			}
			atTokenStart = false;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			wordRunOpen = false;
			atTokenStart = false;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			wordRunOpen = false;
			atTokenStart = false;
			continue;
		}
		if (ch === "#" && atTokenStart) {
			while (i + 1 < command.length && command[i + 1] !== "\n") i++;
			continue;
		}
		if (/\s/.test(ch) && ch !== "\n") {
			flushWord();
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
			flushWord();
			if (ch === "\n" && pendingHeredocs.length > 0) {
				const heredocs = pendingHeredocs.splice(0);
				flushSegment(undefined, i, "seq");
				const consumed = consumeHeredocBodies(command, i + 1, heredocs);
				// A substitution's own text is NOT a range of this command: offsets
				// here are relative to the substituted body, so a redirect inside one
				// is not attributed to any of the command's segments (`-1`) rather
				// than to whichever `cd` its accidental offset lands near.
				for (const substitution of consumed.substitutions)
					segments.push(
						...tokenizeShellCommandWithRanges(substitution).map((entry) => ({
							...entry,
							start: -1,
							end: -1,
						})),
					);
				i = consumed.end;
				segmentStart = i + 1;
				continue;
			}
			let terminator: "pipe" | undefined;
			let exit: ShellSegmentExit = "seq";
			const prev = command[i - 1];
			if (ch === "|" && next === "|") {
				i++;
				exit = "or";
			} else if (ch === "&" && next === "&") {
				i++;
				exit = "and";
			} else if (ch === "|") {
				unsupported = true;
				terminator = "pipe";
				exit = "pipe";
			} else if (ch === "&") {
				unsupported = true;
				exit =
					prev === ">" || prev === "<" || next === ">"
						? "redirect"
						: prev === "|"
							? "pipe"
							: "background";
			}
			flushSegment(terminator, i, exit);
			continue;
		}
		if (ch === "<" || ch === ">") {
			// `2>` names a descriptor, not an argument.
			if (/^\d+$/.test(word)) redirectPending = true;
			flushWord();
			redirectPending = true;
			if (
				ch === "<" &&
				next === "<" &&
				command[i - 1] !== "<" &&
				command[i + 2] !== "<"
			) {
				const parsed = parseHeredocDelimiter(command, i + 2);
				if (parsed) {
					pendingHeredocs.push(parsed.heredoc);
					i = parsed.end;
					// The delimiter was this redirection's word.
					redirectPending = false;
				}
			}
			unsupported = true;
			continue;
		}
		if (ch !== undefined && "(){}`".includes(ch)) grouping = true;
		appendChar(
			ch,
			false,
			LITERAL_WORD_CHAR.test(ch ?? "") || (ch === "~" && word === ""),
		);
		atTokenStart = false;
	}
	if (quote || escaped) unsupported = true;
	flushSegment(undefined, command.length - 1, "end");
	return segments;
}

/**
 * Resolve a bash operand to the file the SHELL opened.
 *
 * A shell word follows shell rules, not host-tool-argument rules (#4577 M1):
 * bash expands a bare leading `~`/`~/` itself and leaves a quoted or escaped
 * one literal, and none of the host resolver's other stages apply — a shell
 * reads the file literally named `@foo.ts`, `file://x` or `a\u202Fb.ts`, so
 * applying the `@` strip, the `file://` conversion or the unicode-space fold
 * here credited a file the command never touched. `~user/x` stays relative:
 * bash would expand it to that user's home, which is not knowable here, and
 * the pre-fix seam left it under the cwd.
 */
function resolveCandidate(token: ShellOperand, cwd: string): string | null {
	const cleaned = stripQuotes(token.text);
	if (!cleaned || cleaned.startsWith("-") || !isReadableSourceFile(cleaned)) {
		return null;
	}
	// A redirect target reaches here still spelled with its quotes
	// (`> "~/x.ts"`); a lexed word lost them, so the segment carries the bit.
	const tildeIsLiteral = token.quotedTilde;
	// `\~/x` survives the lexer backslash-first (it keeps native Windows
	// path separators), and bash reads that tilde literally: drop the escape
	// instead of crediting the phantom `<cwd>/\~/x`.
	const operand =
		cleaned.startsWith("~") && !tildeIsLiteral
			? normalizeHostToolPath(cleaned)
			: cleaned.startsWith("\\~")
				? cleaned.slice(1)
				: cleaned;
	// An already-absolute operand keeps the spelling the command carried: a
	// re-resolve rewrites it (`C:/x/large.ts` -> `C:\x\large.ts` on win32) and
	// the read guard records that spelling (#4019, #4577 R4).
	return path.isAbsolute(operand) ? operand : path.resolve(cwd, operand);
}

/** Parse a count flag value like `-20`, `-n20`, or the `20` following `-n`. */
function parseCountFlag(token: string): number | undefined {
	const digits = token.replace(/^-n?/, "").replace(/[^0-9]/g, "");
	if (!digits) return undefined;
	const n = Number.parseInt(digits, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Unwrap the common agent-authored `npx <tool>` launcher form. */
function unwrapCommand(tokens: ShellOperand[]): {
	verb: string;
	args: ShellOperand[];
} {
	let verb = path.basename(tokens[0]?.text ?? "");
	let args = tokens.slice(1);
	if (verb === "npx") {
		while (args[0]?.text === "-y" || args[0]?.text === "--yes")
			args = args.slice(1);
		verb = path.basename(args[0]?.text ?? "");
		args = args.slice(1);
	}
	return { verb, args };
}

/**
 * Return source-file operands while excluding values consumed by known options.
 * This stays deliberately narrower than a general CLI parser: only formatter
 * options whose values can themselves look like source files belong here.
 */
function formatterFileArgs(
	args: ShellOperand[],
	start = 0,
	valueOptions: ReadonlySet<string> = new Set(),
): ShellOperand[] {
	const files: ShellOperand[] = [];
	for (let i = start; i < args.length; i += 1) {
		const operand = args[i];
		if (!operand) continue;
		const arg = operand.text;
		if (valueOptions.has(arg)) {
			i += 1;
			continue;
		}
		if (arg === "--" || arg.startsWith("-")) continue;
		files.push(operand);
	}
	return files;
}

/**
 * Find redirect targets without treating quoted `>` characters as syntax.
 *
 * Each target carries the offset it starts at, so the caller can attribute it
 * to the simple command that runs it and resolve a relative target against the
 * `cd` in effect for that segment (#2050 AC4).
 */
function extractRedirectTargets(
	command: string,
): Array<{ text: string; index: number }> {
	const targets: Array<{ text: string; index: number }> = [];
	let quote: "single" | "double" | undefined;
	let escaped = false;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (quote === "single") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') quote = undefined;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			continue;
		}
		if (ch === '"') {
			quote = "double";
			continue;
		}
		if (ch !== ">") continue;
		while (i + 1 < command.length && /\s/.test(command[i + 1])) i += 1;
		if (command[i + 1] === ">") i += 1;
		while (i + 1 < command.length && /\s/.test(command[i + 1])) i += 1;
		let target = "";
		for (i += 1; i < command.length; i += 1) {
			const next = command[i];
			if (/\s/.test(next) || next === ";" || next === "|" || next === "&") {
				i -= 1;
				break;
			}
			target += next;
		}
		if (target) targets.push({ text: target, index: i - target.length });
	}
	return targets;
}

/**
 * Extract the line ranges a bash command explicitly showed the agent.
 * Only file-VIEWING commands, and only the exact lines shown:
 *   cat/less/more/bat/nl FILE → whole file
 *   head [-n N] FILE          → lines 1..N (default 10)
 *   tail [-n N] FILE          → last N lines (default 10)
 *   sed -n 'A,Bp' FILE        → lines A..B
 *
 * #1649: `isRecordable` drops a file before its lines are counted, so a view
 * of a vendor or ignored file pays no read. Each file is counted once per
 * command (`head` and `tail` resolve a file twice).
 */
export function extractReadPathsFromCommand(
	command: string,
	cwd: string,
	isRecordable?: (abs: string) => boolean,
): ReadSpan[] {
	const spans: ReadSpan[] = [];
	const seen = new Set<string>();
	const totals = new Map<string, number>();

	const resolveFile = (
		token: ShellOperand,
	): { abs: string; total: number } | null => {
		const abs = resolveCandidate(token, cwd);
		if (!abs) return null;
		try {
			if (!nodeFs.statSync(abs).isFile()) return null;
		} catch {
			return null;
		}
		if (isRecordable && !isRecordable(abs)) return null;
		let total = totals.get(abs);
		if (total === undefined) {
			total = countFileLines(abs);
			totals.set(abs, total);
		}
		return { abs, total };
	};

	const addSpan = (token: ShellOperand, start: number, count: number) => {
		const file = resolveFile(token);
		if (!file) return;
		const offset = Math.min(Math.max(1, start), file.total);
		const limit = Math.min(count, file.total - offset + 1);
		if (limit < 1) return;
		const key = `${file.abs}:${offset}:${limit}`;
		if (seen.has(key)) return;
		seen.add(key);
		spans.push({ filePath: file.abs, offset, limit });
	};

	for (const segment of tokenizeShellCommand(command)) {
		const tokens = shellOperands(segment);
		if (tokens.length === 0) continue;
		const verb = path.basename(tokens[0]?.text ?? "");
		const args = tokens.slice(1);

		if (["cat", "bat", "less", "more", "nl"].includes(verb)) {
			for (const a of args) addSpan(a, 1, Number.MAX_SAFE_INTEGER);
		} else if (verb === "head" || verb === "tail") {
			let count: number | undefined;
			const files: ShellOperand[] = [];
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a?.text === "-n" || a?.text === "-c") {
					const next = args[i + 1];
					if (next !== undefined) {
						count = parseCountFlag(next.text) ?? count;
						i++;
					}
				} else if (/^-n?\d+$/.test(a.text)) {
					count = parseCountFlag(a.text) ?? count;
				} else if (!a.text.startsWith("-")) {
					files.push(a);
				}
			}
			const n = count ?? 10; // GNU head/tail default
			for (const f of files) {
				const file = resolveFile(f);
				if (!file) continue;
				if (verb === "head") addSpan(f, 1, n);
				else addSpan(f, file.total - n + 1, n); // tail: last n lines
			}
		} else if (verb === "sed") {
			if (args.some((arg) => arg.text === "-i")) continue; // sed -i writes, not reads
			let range: { start: number; end: number } | undefined;
			for (const a of args) {
				const m = stripQuotes(a.text).match(/^(\d+),(\d+)p$/);
				if (m) {
					range = {
						start: Number.parseInt(m[1], 10),
						end: Number.parseInt(m[2], 10),
					};
					break;
				}
			}
			if (!range) continue;
			for (const a of args)
				addSpan(a, range.start, range.end - range.start + 1);
		}
	}

	return spans;
}

function grepHasLineNumbers(args: string[]): boolean {
	return args.some((arg) => {
		const token = stripQuotes(arg);
		if (token === "--line-number") return true;
		if (!token.startsWith("-") || token.startsWith("--")) return false;
		return token.slice(1).includes("n");
	});
}

const GREP_OPTIONS_WITH_VALUE = new Set([
	"-e",
	"-f",
	"-m",
	"-A",
	"-B",
	"-C",
	"--regexp",
	"--file",
	"--max-count",
	"--after-context",
	"--before-context",
	"--context",
]);

export interface GrepContextLines {
	before: number;
	after: number;
}

function parseContextValue(
	inline: string,
	next: string | undefined,
): number | undefined {
	const raw = inline !== "" ? inline : next;
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0) return undefined;
	// Bound the credit: a huge -C would credit a whole file from one hit.
	return Math.min(n, 100);
}

/**
 * Read the context lines a `grep` invocation actually PRINTS around each hit
 * (#1904 item 2). Only these lines were delivered to the model, so only these
 * may be credited as read. Handles `-A N`, `-A3`, clustered short flags such as
 * `-rnA3`, `--after-context=N`, the `-B`/`--before-context` mirror, `-C`
 * (both sides), and the bare `-NUM` form.
 */
export function parseGrepContextLines(args: string[]): GrepContextLines {
	let before = 0;
	let after = 0;
	for (let i = 0; i < args.length; i++) {
		const token = stripQuotes(args[i]);
		if (token === "--") break;
		const nextToken =
			args[i + 1] === undefined ? undefined : stripQuotes(args[i + 1]);

		const long = /^--(after|before)-context(?:=(\d+))?$/.exec(token);
		if (long) {
			const value = parseContextValue(long[2] ?? "", nextToken);
			if (value === undefined) continue;
			if (long[1] === "after") after = Math.max(after, value);
			else before = Math.max(before, value);
			continue;
		}
		const longBoth = /^--context(?:=(\d+))?$/.exec(token);
		if (longBoth) {
			const value = parseContextValue(longBoth[1] ?? "", nextToken);
			if (value === undefined) continue;
			before = Math.max(before, value);
			after = Math.max(after, value);
			continue;
		}
		// Bare numeric context form: `grep -3 pattern file`.
		const bare = /^-(\d+)$/.exec(token);
		if (bare) {
			const value = parseContextValue(bare[1], undefined);
			if (value === undefined) continue;
			before = Math.max(before, value);
			after = Math.max(after, value);
			continue;
		}
		// Short flags, possibly clustered: the context flag must be LAST in the
		// cluster because it consumes the remaining characters as its value.
		const short = /^-[A-Za-z]*([ABC])(\d*)$/.exec(token);
		if (!short) continue;
		const value = parseContextValue(short[2], nextToken);
		if (value === undefined) continue;
		if (short[1] === "A") after = Math.max(after, value);
		else if (short[1] === "B") before = Math.max(before, value);
		else {
			before = Math.max(before, value);
			after = Math.max(after, value);
		}
	}
	return { before, after };
}

function extractGrepSearchFiles(args: ShellOperand[], cwd: string): string[] {
	const files: string[] = [];
	let patternSeen = false;
	let endOfOptions = false;
	for (let i = 0; i < args.length; i++) {
		const operand = args[i];
		if (!operand) continue;
		const token = stripQuotes(operand.text);
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && GREP_OPTIONS_WITH_VALUE.has(token)) {
			i++;
			continue;
		}
		if (!endOfOptions && /^-[ef].+/.test(token)) continue;
		if (!endOfOptions && token.startsWith("-")) continue;
		if (!patternSeen) {
			patternSeen = true;
			continue;
		}
		const abs = resolveCandidate(operand, cwd);
		if (!abs) continue;
		try {
			if (!nodeFs.statSync(abs).isFile()) continue;
		} catch {
			continue;
		}
		files.push(abs);
	}
	return files;
}

function parseGrepLineWithFile(
	line: string,
	cwd: string,
): SearchReadLocation | undefined {
	const match = /^(.*?):(\d+):/.exec(stripAnsi(line));
	if (!match) return undefined;
	const lineNumber = Number.parseInt(match[2], 10);
	if (!Number.isFinite(lineNumber) || lineNumber < 1) return undefined;
	// Grep prints shell-expanded filenames. A leading tilde in OUTPUT is
	// literal bytes, not an operand whose quoting can be recovered.
	const abs = resolveCandidate({ text: match[1], quotedTilde: true }, cwd);
	if (!abs) return undefined;
	try {
		if (!nodeFs.statSync(abs).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return { file: abs, startLine: lineNumber, endLine: lineNumber };
}

function parseGrepLineWithoutFile(
	line: string,
	file: string,
): SearchReadLocation | undefined {
	const match = /^(\d+):/.exec(stripAnsi(line));
	if (!match) return undefined;
	const lineNumber = Number.parseInt(match[1], 10);
	if (!Number.isFinite(lineNumber) || lineNumber < 1) return undefined;
	return { file, startLine: lineNumber, endLine: lineNumber };
}

/**
 * Verbs that DROP printed lines from a piped stream (#1908, review F4): a
 * hit that survives such a tail cannot be trusted to still carry the
 * -A/-B/-C context grep's flags declared, because that context may have
 * been among the dropped lines. `head`/`tail` drop by position (even bare,
 * since both default to a 10-line window); `sed` with a `q` command drops
 * everything after the addressed line; `uniq` drops adjacent duplicate
 * lines, which can include a context line that happens to repeat.
 *
 * The criterion is DROPPING, not "changes grep's output shape" — a review
 * finding (#1913 F4) caught this file previously conflating the two:
 *   - `head`/`tail`/`sed q`/`uniq` downstream of a matching grep → some
 *     printed lines are genuinely gone, so credit falls back to
 *     match-line-only (the same conservative default already used for
 *     unparseable commands) rather than trusting the declared flags.
 *   - `sort` and other REORDER-ONLY filters keep every line grep printed,
 *     just in a different order — a surviving `file:line:` match still
 *     carries the full context grep actually printed, so no special case is
 *     needed (proven by the "still credits full context through a
 *     non-truncating pipe tail" test below).
 *   - `wc` and similar filters that REPLACE grep's output entirely (with a
 *     count, say) leave no `file:line:`-shaped line at all, so
 *     `parseGrepOutputSearchReads` already finds zero matches in the real
 *     captured stdout. Also no special case needed, but for the OPPOSITE
 *     reason from `sort`: nothing survives to credit, rather than
 *     everything surviving intact.
 *   - A pass-through filter (`cat`, `grep -v`, ...) between grep and a
 *     dropping tail still counts: the walk below follows the whole pipe
 *     chain, not just the immediate next segment.
 *   - Out of scope, deliberately: `sed -n 'Np'` range-address filtering
 *     without `q`, and `sort -u`, also drop lines but aren't in #1908's
 *     stated scope — revisit if they recur in the field. Also out of
 *     scope: a truncating tail hidden inside a subshell/brace-group
 *     (`( ... )`, `{ ...; }`) or reimplemented in `awk`/`perl` — the shared
 *     tokenizer this file uses doesn't parse inside those, matching its
 *     documented "small conservative shell lexer" scope.
 */
const LINE_DROPPING_TAIL_VERBS = new Set(["head", "tail", "uniq"]);

function isSedQuitCommand(args: string[]): boolean {
	for (const arg of args) {
		const token = stripQuotes(arg);
		if (token.startsWith("-")) continue;
		// A `q` command anchored at the start of the script or after a `;`/
		// newline separator, optionally preceded by a numeric/`$` address
		// (`q`, `1q`, `$q`, `1,3p;q`). Deliberately not a full sed parser.
		if (/(^|[;\n])\s*(\d+|\$)?\s*q\b/.test(token)) return true;
	}
	return false;
}

function isLineDroppingTailCommand(tokens: string[]): boolean {
	const verb = path.basename(stripQuotes(tokens[0] ?? ""));
	if (LINE_DROPPING_TAIL_VERBS.has(verb)) return true;
	if (verb === "sed") return isSedQuitCommand(tokens.slice(1));
	return false;
}

/**
 * True when the grep segment starting at `index` feeds — directly or through
 * a chain of pipes — into a line-dropping tail (#1908). Only an unquoted `|`
 * counts: a `;`/`&&`/`&`-separated command downstream never receives grep's
 * stdout, so it must not downgrade credit (#1913 F2 — this was previously
 * unverified by any test that could tell a real pipe from mere adjacency).
 */
function grepPipesIntoTruncatingTail(
	segments: ShellCommandSegment[],
	index: number,
): boolean {
	if (segments[index]?.terminator !== "pipe") return false;
	for (let j = index + 1; j < segments.length; j++) {
		if (isLineDroppingTailCommand(segments[j].tokens)) return true;
		if (segments[j].terminator !== "pipe") return false;
	}
	return false;
}

function collectGrepCommandFiles(
	command: string,
	cwd: string,
): {
	hasLineNumberGrep: boolean;
	files: Set<string>;
	context: GrepContextLines;
} {
	const files = new Set<string>();
	let hasLineNumberGrep = false;
	// A command can chain several greps whose output all reaches the model, but
	// the parsed hits carry no segment identity. Credit the SMALLEST context any
	// contributing grep printed, so no line is credited that a hit from the
	// narrowest grep never delivered.
	let context: GrepContextLines | undefined;
	// #1908: if ANY contributing grep pipes into a truncating tail, fall back
	// to match-line-only credit for the whole command — the parsed hits carry
	// no segment identity, so a per-segment override isn't representable in
	// the aggregate `context` this function returns.
	let truncated = false;
	const segments = tokenizeShellCommand(command);
	for (let i = 0; i < segments.length; i++) {
		const tokens = segments[i].tokens;
		const verb = path.basename(stripQuotes(tokens[0] ?? ""));
		if (verb !== "grep" && verb !== "egrep" && verb !== "fgrep") continue;
		const args = tokens.slice(1);
		if (!grepHasLineNumbers(args)) continue;
		hasLineNumberGrep = true;
		const segmentContext = parseGrepContextLines(args);
		context = context
			? {
					before: Math.min(context.before, segmentContext.before),
					after: Math.min(context.after, segmentContext.after),
				}
			: segmentContext;
		for (const file of extractGrepSearchFiles(
			shellOperands(segments[i]!).slice(1),
			cwd,
		)) {
			files.add(file);
		}
		if (grepPipesIntoTruncatingTail(segments, i)) truncated = true;
	}
	return {
		hasLineNumberGrep,
		files,
		context: truncated
			? { before: 0, after: 0 }
			: (context ?? { before: 0, after: 0 }),
	};
}

function dedupePushSearchRead(
	out: SearchReadLocation[],
	seen: Set<string>,
	loc: SearchReadLocation | undefined,
): void {
	if (!loc) return;
	const key = `${loc.file}:${loc.startLine}:${loc.endLine ?? loc.startLine}`;
	if (seen.has(key)) return;
	seen.add(key);
	out.push(loc);
}

function parseGrepOutputSearchReads(
	output: string,
	cwd: string,
	singleFile?: string,
): SearchReadLocation[] {
	const out: SearchReadLocation[] = [];
	const seen = new Set<string>();
	for (const rawLine of output.split(/\r?\n/)) {
		if (!rawLine) continue;
		dedupePushSearchRead(out, seen, parseGrepLineWithFile(rawLine, cwd));
		if (singleFile) {
			dedupePushSearchRead(
				out,
				seen,
				parseGrepLineWithoutFile(rawLine, singleFile),
			);
		}
	}
	return out;
}

/**
 * Parse `grep -n` output into the specific lines shown to the agent (#169).
 * Multi-file grep prints `file:line:text`; single-file grep prints `line:text`,
 * so the latter is only accepted when the command names exactly one source file.
 */
export function extractGrepSearchReadsFromOutput(
	command: string,
	cwd: string,
	output: string,
): SearchReadLocation[] {
	const { hasLineNumberGrep, files, context } = collectGrepCommandFiles(
		command,
		cwd,
	);
	if (!hasLineNumberGrep) return [];
	const singleFile = files.size === 1 ? [...files][0] : undefined;
	const locations = parseGrepOutputSearchReads(output, cwd, singleFile);
	// Only the printed context lines were delivered to the model, so only they
	// are credited. A bare grep credits its match line alone (#1904 item 2).
	for (const loc of locations) {
		loc.contextBefore = context.before;
		loc.contextAfter = context.after;
	}
	return locations;
}

/**
 * The file a `cd`/`pushd` operand names, or `undefined` when the operand cannot
 * be known before the shell runs it (`$VAR`, a substitution, a glob, no
 * operand). An option or `cd -` never reaches it: `directoryEffect` admits a
 * plain path start only, for the move and for `cdTargets` alike. #2050
 * AC4: bash rewrites the working directory mid-command, so a relative operand
 * after a `cd` belongs to the directory it entered, not to the directory the
 * command started in. An unknown target leaves the effective directory
 * unchanged — the pre-#2050 answer — rather than crediting the wrong one.
 */
function resolveCdOperand(
	token: ShellOperand | undefined,
	cwd: string,
): string | undefined {
	if (!token) return undefined;
	const cleaned = stripQuotes(token.text);
	if (!cleaned) return undefined;
	// Shell expansions the static parse cannot follow. A directory whose NAME
	// contains one of these is rare; guessing would be the shape-74 defect this
	// resolution exists to remove.
	if (/[$`*?[]/.test(cleaned)) return undefined;
	const operand =
		cleaned.startsWith("~") && !token.quotedTilde
			? normalizeHostToolPath(cleaned)
			: cleaned.startsWith("\\~")
				? cleaned.slice(1)
				: cleaned;
	return path.isAbsolute(operand) ? operand : path.resolve(cwd, operand);
}

/** What one bash command names: the files it writes, and the `cd` targets. */
export interface ShellWriteScan {
	/** Absolute paths the command writes or creates, in command order. */
	written: string[];
	/**
	 * Absolute directories the command's `cd`/`pushd` names, in command order,
	 * read from the words `directoryEffect` reads (#4713 R8-1). #2050: opaque recovery takes its baseline in each of these
	 * that is a checkout of the session's own repository, so a write in a
	 * linked worktree is recovered from THAT root.
	 */
	cdTargets: string[];
}

/**
 * Parse a bash command for the files it WROTE/created, so the read-guard can
 * treat them as authored by the agent (mirrors the Write tool), and for the
 * directories it `cd`ed into. Handles:
 *   redirects: `> FILE`, `>> FILE`, `N> FILE`, `&> FILE` (with or without space)
 *   tee [-a] FILE..., sed -i ... FILE, cp/mv/install ... DEST, touch FILE...,
 *   and common in-place formatter/fixer invocations with explicit file targets.
 *
 * Every operand resolves against the working directory in effect for ITS
 * segment, so `cd <dir> && echo x > f.ts` names `<dir>/f.ts` (#2050 AC4).
 *
 * That directory moves only where bash certainly moves it (#4713 round 4): see
 * {@link directoryEffect} for the admitted forms. A directory builtin in a
 * pipeline or a backgrounded list leaves it alone (bash ran it in a subshell);
 * anything else the scan cannot certify returns it to `cwd`, the pre-#2050
 * answer, for the rest of the command.
 *
 * Returns absolute paths. The file need not exist yet (it may be created) —
 * existence is confirmed later by recordWritten at tool_result time.
 */
export function scanShellWriteScopes(
	command: string,
	cwd: string,
): ShellWriteScan {
	const out = new Set<string>();
	const cdTargets: string[] = [];
	const seenCdTargets = new Set<string>();
	// The working directory in effect for the segment being read, which a `cd`
	// or `pushd` in an earlier segment moves.
	let effectiveCwd = cwd;
	// The `pushd` directory stack, holding only the pushes this scan admitted,
	// so a `popd` returns to the directory it restores (#4713 F1).
	const dirStack: string[] = [];
	// Set once the scan meets a directory change it cannot certify; from then
	// on every operand resolves against `cwd`, as before #2050.
	let fellBack = false;
	// Set when the current `&&` chain holds a move entered after `&&`: bash
	// made it only if the left side succeeded, which is certain inside the
	// chain (a later `&&` command runs only then) and unknowable past its end.
	let chainMove = false;
	const fallBack = () => {
		fellBack = true;
		effectiveCwd = cwd;
		dirStack.length = 0;
		chainMove = false;
	};
	const add = (token: ShellOperand) => {
		const abs = resolveCandidate(token, effectiveCwd);
		if (abs) out.add(abs);
	};
	// Every directory a `cd`/`pushd` names is a candidate recovery root,
	// whether or not the scan can certify that the shell stayed there.
	const nameCdTarget = (target: string | undefined) => {
		if (target && !seenCdTargets.has(target)) {
			seenCdTargets.add(target);
			cdTargets.push(target);
		}
	};

	// Redirect targets are collected by a quote-aware scanner. The shared
	// tokenizer supplies the normalized command arguments; it deliberately does
	// not expose shell redirection operators as arguments. Each target is
	// attributed to the segment whose range holds it, then resolved against the
	// `cd` in effect there. A substitution's own segments carry `end: -1` (its
	// offsets are relative to the substituted body), so a `>` inside a heredoc
	// body is not credited to this command at all.
	const redirects = extractRedirectTargets(command);
	let redirectCursor = 0;
	const ranges = tokenizeShellCommandWithRanges(command);
	const backgrounded = backgroundedRanges(ranges);
	// How the current simple command was entered (`seq` at list start), and its
	// ranges so far: a redirection's `&` splits one command into two ranges.
	let entry: ShellSegmentExit = "seq";
	let simpleCommand: ShellSegmentRange[] = [];
	for (const [rangeIndex, range] of ranges.entries()) {
		const { segment, start: segmentStart, end: segmentEnd } = range;
		if (segmentEnd >= 0) {
			for (; redirectCursor < redirects.length; redirectCursor += 1) {
				const redirect = redirects[redirectCursor];
				if (!redirect || redirect.index > segmentEnd) break;
				// A heredoc body's offsets sit in the gap between two segments, so
				// the first segment after the body would otherwise claim its `>`
				// (#4713 F5).
				if (redirect.index < segmentStart) continue;
				add({
					text: redirect.text,
					quotedTilde: /^['"]/.test(redirect.text),
				});
			}
		}
		const tokens = shellOperands(segment);
		const { verb, args } =
			tokens.length === 0
				? { verb: "", args: [] as ShellOperand[] }
				: unwrapCommand(tokens);

		if (verb === "tee" || verb === "touch") {
			for (const a of args) if (!a.text.startsWith("-")) add(a);
		} else if (verb === "sed" && args.some((arg) => arg.text === "-i")) {
			for (const a of args) add(a);
		} else if (verb === "cp" || verb === "mv" || verb === "install") {
			// Known miss (#1668 review F3): the GNU `-t DEST`/`--target-directory`
			// form puts the destination BEFORE the sources — this always treats
			// the LAST non-flag argument as the destination, so `-t DEST SRC` and
			// multi-source `-t DEST SRC1 SRC2...` are misread. Rare in agent-
			// authored bash (source-before-dest is the common form); documented
			// rather than fixed, since correctly parsing `-t` means recognizing it
			// takes a value while telling it apart from every other single-letter
			// flag this same branch already ignores.
			const files = args.filter((a) => !a.text.startsWith("-"));
			if (files.length >= 1) add(files[files.length - 1]); // destination
		} else if (verb === "biome") {
			const sub = args[0]?.text;
			if (
				(sub === "format" || sub === "check") &&
				args.some((arg) => arg.text === "--write")
			) {
				for (const file of formatterFileArgs(
					args,
					1,
					new Set(["--config-path"]),
				))
					add(file);
			}
		} else if (
			verb === "prettier" &&
			args.some((arg) => arg.text === "--write")
		) {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--config", "--ignore-path", "--parser", "--plugin"]),
			))
				add(file);
		} else if (verb === "eslint" && args.some((arg) => arg.text === "--fix")) {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--config", "--ignore-path", "--parser", "--plugin"]),
			))
				add(file);
		} else if (verb === "ruff") {
			const sub = args[0]?.text;
			if (sub === "format" || args.some((arg) => arg.text === "--fix")) {
				const start = sub === "format" || sub === "check" ? 1 : 0;
				for (const file of formatterFileArgs(
					args,
					start,
					new Set(["--config"]),
				))
					add(file);
			}
		} else if (verb === "gofmt" && args.some((arg) => arg.text === "-w")) {
			for (const file of formatterFileArgs(args)) add(file);
		} else if (verb === "cargo" && args[0]?.text === "fmt") {
			// Bare cargo fmt is project-scoped and cannot be enumerated without a
			// filesystem walk. Only explicit rustfmt operands after `--` are safe.
			const separator = args.findIndex((arg) => arg.text === "--");
			if (separator >= 0) {
				for (const file of formatterFileArgs(
					args,
					separator + 1,
					new Set(["--edition", "--config-path"]),
				))
					add(file);
			}
		} else if (verb === "rustfmt") {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--edition", "--config-path"]),
			))
				add(file);
		} else if (verb === "black") {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set([
					"--config",
					"--exclude",
					"--include",
					"--line-length",
					"--target-version",
				]),
			))
				add(file);
		} else if (
			verb === "clang-format" &&
			args.some((arg) => arg.text === "-i")
		) {
			for (const file of formatterFileArgs(
				args,
				0,
				new Set(["--style", "--fallback-style", "--assume-filename"]),
			))
				add(file);
		} else if (verb === "dotnet" && args[0]?.text === "format") {
			// dotnet format is normally solution-scoped. `--include` is the one
			// invocation form that provides attributable source paths.
			for (let i = 1; i < args.length; i += 1) {
				if (args[i]?.text === "--include" && args[i + 1]) {
					for (const file of (args[i + 1]?.text ?? "").split(","))
						add({ text: file, quotedTilde: args[i + 1]?.quotedTilde === true });
					i += 1;
				} else if (args[i]?.text.startsWith("--include=")) {
					for (const file of (args[i]?.text ?? "")
						.slice("--include=".length)
						.split(","))
						add({ text: file, quotedTilde: args[i]?.quotedTilde === true });
				}
			}
		} else if (verb === "git") {
			// git ops that REWRITE working-tree files with explicit paths:
			//   git checkout [<ref>] -- <files>   git restore [opts] <files>
			// These restore content but never go through the edit tool, so without
			// this pi-lens keeps stale diagnostics/fileSeq for the restored file.
			// Whole-tree ops (reset --hard, stash pop, revert, merge, rebase, pull,
			// or `git checkout <branch>`) don't name files and aren't handled here.
			const sub = args[0]?.text;
			if (sub === "checkout" || sub === "restore") {
				const dashDash = args.findIndex((arg) => arg.text === "--");
				const fileArgs =
					dashDash >= 0
						? args.slice(dashDash + 1)
						: sub === "restore"
							? args.slice(1).filter((a) => !a.text.startsWith("-"))
							: []; // `git checkout` without `--` is ambiguous (ref vs path)
				for (const a of fileArgs) add(a);
			} else if (sub === "mv") {
				// git mv SRC... DEST — the destination is a write, exactly like
				// plain `mv` above (#1668 review F2). The source side is a delete,
				// handled by extractDeletedPathsFromCommand.
				const files = args.slice(1).filter((a) => !a.text.startsWith("-"));
				if (files.length >= 1) add(files[files.length - 1]);
			}
		}
		// A heredoc's substitution runs in a subshell and joins no list: it
		// names a directory, and moves none.
		if (segmentEnd < 0) {
			nameCdTarget(directoryEffect([range], effectiveCwd).named);
			continue;
		}
		simpleCommand.push(range);
		if (range.exit === "redirect") continue;
		const exit = range.exit;
		const effect = directoryEffect(simpleCommand, effectiveCwd);
		simpleCommand = [];
		nameCdTarget(effect.named);
		const previousEntry = entry;
		entry = exit;
		if (fellBack || effect.kind === "none") {
			// No directory change of its own.
		} else if (effect.kind === "construct") {
			fallBack();
		} else if (
			previousEntry === "pipe" ||
			exit === "pipe" ||
			backgrounded[rangeIndex]
		) {
			// A pipeline member or a backgrounded list runs in a subshell: its
			// directory change never reaches the next command.
		} else if (
			previousEntry === "or" ||
			exit === "or" ||
			effect.kind === "unknown"
		) {
			// A move is certain only when entered at list start or after
			// `&&`/`;`/newline/`&` and ended by `&&`/`;`/newline/the end, in a
			// form the scan reads; anything else falls back.
			fallBack();
		} else if (effect.kind === "move") {
			if (effect.push) dirStack.push(effectiveCwd);
			effectiveCwd = effect.target;
			if (previousEntry === "and") chainMove = true;
		} else {
			const restored = dirStack.pop();
			if (restored === undefined) fallBack();
			else {
				effectiveCwd = restored;
				if (previousEntry === "and") chainMove = true;
			}
		}
		// Only `&&` and `|` continue the chain; past its end the move it holds
		// may never have happened (#4713 R5-1).
		if (chainMove && exit !== "and" && exit !== "pipe") fallBack();
	}

	return { written: Array.from(out), cdTargets };
}

/** Bash reserved words: a command starting with one opens or closes a construct. */
const SHELL_RESERVED_WORDS: ReadonlySet<string> = new Set([
	"!",
	"[[",
	"]]",
	"{",
	"}",
	"case",
	"coproc",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"select",
	"then",
	"time",
	"until",
	"while",
]);

/**
 * Builtins that run shell text in the current shell or change how a later
 * word resolves, so the directory after them is not knowable statically.
 */
const SHELL_CODE_BUILTINS: ReadonlySet<string> = new Set([
	".",
	"alias",
	"builtin",
	"command",
	"enable",
	"eval",
	"shopt",
	"source",
	"trap",
]);

/** The first character of an operand bash reads as a directory path. */
const PLAIN_PATH_START = /^[A-Za-z0-9_./~]/;

/** A bash assignment word's name and `=`, when bash reads them unquoted. */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

type DirectoryEffect = (
	| { kind: "none" }
	| { kind: "construct" }
	| { kind: "unknown" }
	| { kind: "move"; target: string; push: boolean }
	| { kind: "pop" }
) & {
	/**
	 * The directory a `cd`/`pushd` names, whether or not the move is certain:
	 * a recovery-root candidate (#2050, the `cdTargets` list).
	 */
	named?: string | undefined;
};

/**
 * What one simple command does to the shell's directory, read as a positive
 * list (#4713 round 4). Admitted: `cd DIR` and `pushd DIR` with exactly one
 * statically resolvable plain path operand (a literal word, see
 * `literalWords`, starting with a `PLAIN_PATH_START` character), and a bare
 * `popd`, each spelled as that literal first word once leading assignments
 * and redirections are set aside.
 * A command whose first word is a plain word naming none of the directory or
 * shell-text builtins is `none`. A reserved word or an unquoted grouping
 * character is a `construct`; every other form is `unknown`.
 *
 * `named` reads the same words more loosely (#4713 R8-1): a `builtin` or
 * `command` prefix, an escaped verb (`\cd`), an option before the operand or
 * a second operand still name the directory, which the move rule leaves
 * `unknown`.
 */
function directoryEffect(
	ranges: readonly ShellSegmentRange[],
	cwd: string,
): DirectoryEffect {
	const words: ShellOperand[] = [];
	const literal: boolean[] = [];
	const unquoted: number[] = [];
	for (const range of ranges)
		for (const [index, operand] of shellOperands(range.segment).entries())
			if (range.redirectWords[index] !== true) {
				words.push(operand);
				literal.push(range.literalWords[index] === true);
				unquoted.push(range.unquotedLengths[index] ?? 0);
			}
	// Bash takes `NAME=value` as an assignment only when the name and `=` are
	// unquoted; `'FOO=bar' cd sub` runs a command named `FOO=bar` (#4713 R8-3).
	let first = 0;
	for (;;) {
		const prefix = ASSIGNMENT_PREFIX.exec(words[first]?.text ?? "");
		if (!prefix || prefix[0].length > (unquoted[first] ?? 0)) break;
		first++;
	}
	// The command a word names, compared below with builtin names only: the
	// literal word, or an unquoted one whose backslashes bash removes (`\cd`,
	// `c\d`). A word with any quoted character and no literal flag names none.
	const commandName = (index: number): string | undefined => {
		const text = words[index]?.text;
		if (text === undefined || literal[index]) return text;
		return unquoted[index] === text.length
			? text.replace(/\\/g, "")
			: undefined;
	};
	let at = first;
	while (commandName(at) === "builtin" || commandName(at) === "command") at++;
	let named: string | undefined;
	if (commandName(at) === "cd" || commandName(at) === "pushd") {
		const index = words.findIndex(
			(word, i) => i > at && !word.text.startsWith("-"),
		);
		const operand = words[index];
		// The move rule's operand test (#4713 R7-1, R8-2): bash's own word, with
		// no expansion (`~+1`, `~-`, `~user`, `$D`), and a plain path start.
		if (operand && literal[index] && PLAIN_PATH_START.test(operand.text))
			named = resolveCdOperand(operand, cwd);
	}
	if (ranges.some((range) => range.grouping))
		return { kind: "construct", named };
	const verb = words[first]?.text;
	if (verb === undefined) return { kind: "none" };
	if (SHELL_RESERVED_WORDS.has(verb)) return { kind: "construct" };
	const operands = words.slice(first + 1);
	if (verb === "cd" || verb === "pushd") {
		// The directory moves only on one plain path operand (#4713 R7-1):
		// `named` is then that operand, and it is set only when bash runs `cd`
		// (`"\c"d` runs `\cd`). Every other form (a stack index or option,
		// `~+1`, `~user`, `$D`, a glob, an escape the tokenizer resolves unlike
		// bash, a prefix) falls back.
		return operands.length === 1 && named
			? { kind: "move", target: named, push: verb === "pushd", named }
			: { kind: "unknown", named };
	}
	if (verb === "popd")
		return operands.length === 0 ? { kind: "pop" } : { kind: "unknown" };
	if (SHELL_CODE_BUILTINS.has(verb) || !/^[\w./+@%:,~[\]-]+$/.test(verb))
		return { kind: "unknown", named };
	return { kind: "none" };
}

/**
 * Per range: whether its list ends in a lone `&`, so bash ran every command of
 * that list in a background subshell.
 */
function backgroundedRanges(ranges: readonly ShellSegmentRange[]): boolean[] {
	const backgrounded = ranges.map(() => false);
	let listStart = 0;
	for (const [index, range] of ranges.entries()) {
		if (range.end < 0) continue;
		if (
			range.exit !== "seq" &&
			range.exit !== "background" &&
			range.exit !== "end"
		)
			continue;
		if (range.exit === "background")
			for (let k = listStart; k <= index; k += 1) backgrounded[k] = true;
		listStart = index + 1;
	}
	return backgrounded;
}

/**
 * The files a bash command WROTE/created. Thin reading of
 * {@link scanShellWriteScopes}, which is the one place the command is walked.
 */
export function extractWrittenPathsFromCommand(
	command: string,
	cwd: string,
): string[] {
	return scanShellWriteScopes(command, cwd).written;
}

/**
 * Extract files a bash command likely DELETED, for the type-3 (Deleted)
 * watched-files gap (#1668): `rm FILE...`, `git rm FILE...`, and the SOURCE
 * side of `mv SRC DEST` / `git mv SRC DEST` (the destination is a write,
 * covered by `extractWrittenPathsFromCommand` — including for `git mv`,
 * #1668 review F2).
 *
 * Deliberately narrow: only commands naming an explicit file target are
 * handled. A bare directory op (`rm -rf dir/`, `git clean`) is skipped —
 * resolving what vanished inside a directory would mean listing it before
 * and after, the "stat the world" cost this module exists to avoid. The
 * caller confirms each candidate by checking it no longer exists on disk;
 * this function only proposes what the command named.
 */
export function extractDeletedPathsFromCommand(
	command: string,
	cwd: string,
): string[] {
	const out = new Set<string>();
	const add = (token: ShellOperand) => {
		const abs = resolveCandidate(token, cwd);
		if (abs) out.add(abs);
	};
	// mv SRC... DEST / git mv SRC... DEST — every argument except the last is
	// a source that vanishes from its original path once the move lands.
	// Known miss (#1668 review F3): the same `-t DEST`/`--target-directory`
	// form documented in `extractWrittenPathsFromCommand` misreads here too —
	// this assumes source-before-destination order.
	const addMoveSources = (args: ShellOperand[]) => {
		const files = args.filter((a) => !a.text.startsWith("-"));
		if (files.length >= 2) {
			for (const src of files.slice(0, -1)) add(src);
		}
	};

	for (const segment of tokenizeShellCommand(command)) {
		const tokens = shellOperands(segment);
		if (tokens.length === 0) continue;
		const verb = path.basename(tokens[0]?.text ?? "");
		const args = tokens.slice(1);

		if (verb === "rm") {
			for (const a of args) if (!a.text.startsWith("-")) add(a);
		} else if (verb === "git" && args[0]?.text === "rm") {
			const rmArgs = args.slice(1);
			const dashDash = rmArgs.findIndex((arg) => arg.text === "--");
			const fileArgs =
				dashDash >= 0
					? rmArgs.slice(dashDash + 1)
					: rmArgs.filter((a) => !a.text.startsWith("-"));
			for (const a of fileArgs) add(a);
		} else if (verb === "git" && args[0]?.text === "mv") {
			addMoveSources(args.slice(1));
		} else if (verb === "mv") {
			addMoveSources(args);
		}
	}

	return Array.from(out);
}

/**
 * One edit-class predicate for the `tool_result` path (#2939 F3).
 *
 * `index.ts` used to answer "is this an edit-class result" twice — once in
 * the handler body (gated on `toolName === "bash"`) and once in the
 * `budgetKey` callback (no tool gate) — and the copies disagreed on the
 * first third-party case tried (`mcp__acme__shell` with `input.command`:
 * wrapper said edit, handler said read-only). Both call sites now share
 * this function, so the answer is written once — but the call sites
 * themselves are not yet pinned (W4/M8, #2939), so a future tool-name gate
 * re-introduced at one of them would still pass the suite.
 *
 * A result is edit-class when the mutation seam classifies it, or when its
 * `input.command` names written files. The command half carries no tool-name
 * gate on purpose: a shell that wrote files runs the same pipeline whatever
 * its tool is named, and the edit budget must cover that work.
 */
export function isEditClassToolResult(
	event: { toolName?: string; input?: { command?: unknown } },
	cwd: string,
): boolean {
	if (classifyMutatingTool(event, { recognizeOnly: true }) !== undefined) {
		return true;
	}
	const command = event?.input?.command;
	return (
		typeof command === "string" &&
		extractWrittenPathsFromCommand(command, cwd).length > 0
	);
}
