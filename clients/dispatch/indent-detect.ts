type IndentStyle = "tab" | "space";

export interface Indentation {
	style: IndentStyle;
	width: number;
}

const DEFAULT_INDENTATION: Indentation = { style: "space", width: 2 };

/**
 * Infer the prevailing indentation convention from lines that are indented.
 * Formatter callers use it only as a conservative fallback when the repository
 * has no config. It has two pieces of lexical knowledge: the `/* … *\/` block
 * comment and the multi-line template literal, whose interior lines are
 * alignment rather than nesting; everything else is counted as written.
 */
export function detectIndentation(content: string): Indentation | undefined {
	const lines = structuralLines(content.split(/\r?\n/));
	const tabs = lines.filter((line) => /^\t+\S/.test(line)).length;
	const spaceCounts = lines
		.map((line) => line.match(/^ +(?=\S)/)?.[0].length ?? 0)
		.filter((count) => count > 0);

	if (tabs === 0 && spaceCounts.length === 0) return DEFAULT_INDENTATION;
	if (tabs > spaceCounts.length) return { style: "tab", width: 1 };
	if (spaceCounts.length > tabs) {
		const minimum = Math.min(...spaceCounts);
		// 0 is GCD's identity, so seeding the fold both satisfies "reduce needs an
		// initial value" and leaves every result unchanged.
		const gcd = spaceCounts.reduce(
			(unit, count) => greatestCommonDivisor(unit, count),
			0,
		);
		const nonBlank = lines
			.map((line) => line.match(/^( *)\S/)?.[1]?.length)
			.filter((count): count is number => count !== undefined);
		const hasStructuralBoundary = nonBlank.some((count, index) => {
			const previous = nonBlank[index - 1];
			return count === minimum && previous !== undefined && previous < minimum;
		});
		if (hasStructuralBoundary && minimum <= 8) {
			return { style: "space", width: minimum };
		}
		// A continuation line can be the shallowest observed line even though it
		// is not one indentation unit from the surrounding structure. GCD gives
		// those aligned runs their structural unit (for example 4/6 -> 2).
		if (gcd < minimum && gcd <= 8) {
			return { style: "space", width: gcd };
		}
		// A file containing only nested runs (for example 6/12 spaces) has no
		// evidence that its first run is one unit rather than three or six. Do
		// not impose a formatter style on that ambiguous evidence.
		return undefined;
	}

	return DEFAULT_INDENTATION;
}

/**
 * Whether the line opens a block comment that it does not also close. A `/*`
 * that follows a `//` on the same line is inside a line comment, not an
 * opener; a `//` that follows the `/*` (a URL in a banner) is not.
 */
function opensBlockComment(line: string): boolean {
	const blockAt = line.indexOf("/*");
	if (blockAt < 0) return false;
	const lineAt = line.indexOf("//");
	if (lineAt >= 0 && lineAt < blockAt) return false;
	return line.indexOf("*/", blockAt + 2) < 0;
}

/**
 * One boolean per line: true when the line sits *inside* a terminated block
 * comment, so its leading space is alignment on the opener's `*` column, not
 * a nesting unit. The opener line itself is false (its own indentation *is*
 * structural). An opener that never closes was a `/*` inside a string or a
 * regex, so its lines are left false rather than silently swallowed.
 *
 * Shared by {@link structuralLines} (drops the lines from indentation
 * detection's own evidence — a top-level JSDoc otherwise contributes a run
 * of 1-space lines, so a 2- or 4-space file with doc comments reads as width
 * 1 and a tab file with a top-level JSDoc reads as spaces, #3039 F1/F2) and
 * by `clients/indent-retarget.ts`'s `retargetReplacementIndentation`, which
 * must not pick its base nesting unit from a comment's alignment column
 * either (#3052) — one lexer for "which lines carry structure", not two.
 */
export function blockCommentInteriorMask(lines: string[]): boolean[] {
	const mask: boolean[] = Array.from({ length: lines.length }, () => false);
	let pendingStart = -1;
	for (const [i, line] of lines.entries()) {
		if (pendingStart >= 0) {
			mask[i] = true;
			if (line.includes("*/")) pendingStart = -1;
			continue;
		}
		if (opensBlockComment(line)) pendingStart = i;
	}
	if (pendingStart >= 0) {
		for (let i = pendingStart + 1; i < lines.length; i += 1) mask[i] = false;
	}
	return mask;
}

type TemplateFrame =
	| { kind: "template" }
	| { kind: "expr"; braceDepth: number }
	| { kind: "block" };

/** Whether `stack` holds a frame the mask (or its fail-safe) must treat as
 * "inside a template" — every frame except `"block"`. A `/* … *\/` comment
 * nested in the tracked span (plain code, or inside a `${ … }` substitution)
 * is not itself template evidence; {@link blockCommentInteriorMask} already
 * excludes a top-level block comment's own lines. */
function hasLiveFrame(stack: TemplateFrame[]): boolean {
	return stack.some((frame) => frame.kind !== "block");
}

/**
 * Advance a lexical stack over one line of source, mutating it in place.
 * Shared by {@link templateLiteralInteriorMask}'s per-line pass. `stack`
 * empty means plain code; a `"template"` frame means raw template text; an
 * `"expr"` frame means code inside a `${ … }` substitution, with its own
 * brace-depth counter so a nested `{`/`}` (an object literal, a block) does
 * not close the substitution early — only the brace that returns the counter
 * to 0, the one that matches the `${`, does; a `"block"` frame means a
 * `/* … *\/` comment, so a JSDoc's own backtick (a fenced code sample, an
 * inline `` `x` ``) never opens a tracked template that then swallows real
 * code up to whatever later backtick happens to close it (#3059 review F1,
 * AGENTS.md shape 43 — prose mistaken for executable structure).
 *
 * A backtick, `//`, `/*`, or quote character means nothing while `//` has
 * already started a line comment, a `/* … *\/` comment is open, or a quoted
 * string is open, so all three states resolve before the general
 * per-character switch (line comments run to EOL; quoted strings skip
 * everything up to their own unescaped terminator, taking a backtick inside
 * them out of consideration the same way; a block comment skips everything,
 * backticks included, up to its own `*\/`, possibly spanning lines).
 *
 * Known gap: a regex literal has no state here, so a backtick inside one
 * (`` /`foo/ ``) is indistinguishable from a real opener — the same caveat
 * `opensBlockComment` already concedes for `/*`. An even count across a
 * file can mask code between two such regexes without tripping the
 * opener-never-closes fail-safe; tracked as #3120 rather than fixed here (a
 * first-pass regex-opener heuristic over-declined the corpus 54 files vs 5
 * for a real fix elsewhere in this lexer). The same regex blindness has a
 * second, block-frame face: a `/*` inside a regex literal (`` /[/*]/ ``) is
 * read the same way — it pushes a `"block"` frame that then waits for a
 * closing `*\/` the regex never produced, so it stays open for the rest of
 * the file and silently disables the template mask past that point. Both
 * faces are monotonically safe (under-masking only, degrading to pre-#3059
 * behaviour) and are covered by the same #3120 known-limit decision rather
 * than a lexer change here.
 */
function advanceTemplateState(line: string, stack: TemplateFrame[]): void {
	let j = 0;
	while (j < line.length) {
		const top = stack[stack.length - 1];
		if (top?.kind === "template") {
			if (line[j] === "\\") {
				j += 2; // an escaped character, including an escaped backtick, \`
				continue;
			}
			if (line.startsWith("${", j)) {
				stack.push({ kind: "expr", braceDepth: 1 });
				j += 2;
				continue;
			}
			if (line[j] === "`") {
				stack.pop();
				j += 1;
				continue;
			}
			j += 1;
			continue;
		}
		if (top?.kind === "block") {
			const closeAt = line.indexOf("*/", j);
			if (closeAt < 0) return; // still inside the comment at EOL
			stack.pop();
			j = closeAt + 2;
			continue;
		}
		// Plain code, at the top level or inside a `${ … }` substitution.
		if (line.startsWith("//", j)) return; // rest of line is a line comment
		if (line.startsWith("/*", j)) {
			stack.push({ kind: "block" });
			j += 2;
			continue;
		}
		const ch = line[j];
		if (ch === '"' || ch === "'") {
			j = skipQuoted(line, j, ch);
			continue;
		}
		if (ch === "`") {
			stack.push({ kind: "template" });
			j += 1;
			continue;
		}
		if (top?.kind === "expr") {
			if (ch === "{") {
				top.braceDepth += 1;
				j += 1;
				continue;
			}
			if (ch === "}") {
				top.braceDepth -= 1;
				j += 1;
				if (top.braceDepth === 0) stack.pop();
				continue;
			}
		}
		j += 1;
	}
}

/** Skip a single- or double-quoted string starting at `quote`, honoring `\`
 * escapes, so a backtick (or anything else) inside it is never inspected. */
function skipQuoted(line: string, start: number, quote: string): number {
	let j = start + 1;
	while (j < line.length) {
		if (line[j] === "\\") {
			j += 2;
			continue;
		}
		if (line[j] === quote) return j + 1;
		j += 1;
	}
	return line.length; // unterminated on this line; nothing more to find
}

/**
 * One boolean per line: true when the line sits *inside* a multi-line
 * template literal (or a `${ … }` substitution nested in one), so its leading
 * space is alignment on the surrounding text or expression, not a nesting
 * unit — the same shape as {@link blockCommentInteriorMask} for `/* … *\/`
 * (#3059, a fourth member of AGENTS.md defect 49). The opener line itself is
 * false (its own indentation *is* structural); a backtick inside a `//` line
 * comment or a quoted string must not open a template (`advanceTemplateState`
 * resolves both before treating a backtick as an opener); `${ … }` nesting
 * and escaped backticks are tracked through the frame stack so neither an
 * object literal inside a substitution nor an escaped backtick in template
 * text closes anything early. A template that never closes by EOF was
 * (like an unterminated block comment) something this lexer misread — a
 * backtick inside a regex literal, say — so its lines are left false rather
 * than silently swallowed.
 */
export function templateLiteralInteriorMask(lines: string[]): boolean[] {
	const mask: boolean[] = Array.from({ length: lines.length }, () => false);
	const stack: TemplateFrame[] = [];
	let openLine = -1;
	for (const [i, line] of lines.entries()) {
		if (hasLiveFrame(stack)) {
			mask[i] = true;
		} else {
			openLine = i;
		}
		advanceTemplateState(line, stack);
	}
	if (hasLiveFrame(stack)) {
		for (let i = openLine + 1; i < lines.length; i += 1) mask[i] = false;
	}
	return mask;
}

function structuralLines(lines: string[]): string[] {
	const blockCommentMask = blockCommentInteriorMask(lines);
	const templateMask = templateLiteralInteriorMask(lines);
	return lines.filter(
		(_, index) => !blockCommentMask[index] && !templateMask[index],
	);
}

function greatestCommonDivisor(left: number, right: number): number {
	while (right !== 0) [left, right] = [right, left % right];
	return left;
}

/** Whether the content supplied evidence from which a style can be inferred. */
export function hasDetectableIndentation(content: string): boolean {
	return /^(?:\t+| {1,})\S/m.test(content);
}
