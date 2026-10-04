Warning: truncated output (original token count: 24798)
Total output lines: 2492

#!/usr/bin/env node
/**
 * scripts/hooks/guard-bash.mjs (#2699, refs umbrella #2697)
 *
 * PreToolUse hook for the Bash tool. Mechanically enforces six
 * non-negotiables that previously lived only as prose in CLAUDE.md and the
 * fixer/reviewer playbooks -- a fixer ran `git stash` on 2026-09-07 (the
 * #2686 lane), two review probes wrote into the real `~/.pi-lens` on
 * 2026-09-02 (#2506), a fixer pointed TMPDIR at the vitest harness home
 * on 2026-09-15 (#3026), and twice on 2026-09-16 a fixer ran
 * `git worktree remove` on a tree whose `node_modules` was a symlink into
 * the shared checkout, so git followed the link and emptied the shared
 * install (#3173), all rules a hook can catch that prose could not:
 *
 *   - `git stash` in any form (CLAUDE.md non-negotiable)
 *   - `git reset --soft origin/<branch>` / `git reset --hard <anything>`
 *   - a HAND-typed `git worktree remove` with two force flags (the
 *     sanctioned removal is `node scripts/prune-agent-worktrees.mjs`,
 *     liveness-checked, or unlock + single force)
 *   - ANY `git worktree remove` (force or not) on a worktree whose
 *     `node_modules` is a symlink pointing OUTSIDE that worktree (#3173,
 *     the #2704 class) -- see {@link hasNodeModulesSymlinkOutside}
 *   - an unpinned `node` probe that LOADS built runtime code from clients/
 *     or dist/ (not merely a payload that mentions "clients/" in passing --
 *     review round 2 F5) with no PI_LENS_HOME pin (AGENTS.md "Probe
 *     hygiene")
 *   - `TMPDIR`/`TMP`/`TEMP` aimed at the vitest harness's own home
 *     (AGENTS.md "Probe hygiene", #3026) -- see {@link classifyTempDirVars}
 *   - a git HOOK BYPASS on `git commit`/`push`/`merge`/`rebase` (#3778, the
 *     #3703 class): `--no-verify`, `-n` (commit only -- on `push` it is
 *     `--dry-run`), `-c core.hooksPath=…`, a `git config core.hooksPath`
 *     write, and the `HUSKY=0` / `PI_LENS_SKIP_HOOKS` env prefixes the repo's
 *     husky hooks honour -- see {@link classifyHookBypass}
 *   - force pushes and `+refspec` pushes; an exact
 *     `--force-with-lease=<branch>:<sha>` is the only force form allowed
 *   - rebase starts and completion forms. Recovery with `--abort` or `--quit`
 *     remains available; merge `origin/master` instead of starting a rebase.
 *
 * ## Contract source
 *
 * Fetched https://code.claude.com/docs/en/hooks (docs.anthropic.com/en/docs/
 * claude-code/hooks 301-redirects there) on 2026-09-07. A PreToolUse hook
 * receives this on stdin:
 *   { session_id, transcript_path, cwd, permission_mode, hook_event_name,
 *     tool_name, tool_input, tool_use_id, ... }
 * For the Bash tool, `tool_input = { command: string, ... }`. A hook denies
 * the call in one of two ways: (a) exit code 2 with the reason written to
 * stderr, or (b) exit 0 and print
 * `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":
 * "deny","permissionDecisionReason":"..."}}` to stdout. This script uses
 * (a) -- the issue's own wording ("exit 2 with a one-line teaching message")
 * names it, and it is the simpler of the two to test (one exit code, one
 * stream, no JSON-shape drift risk on stdout).
 *
 * ## Shape: subtract the inert regions, THEN tokenize (review round 3)
 *
 * Round 2 delimited a `$( … )` span with a standalone paren/quote counter
 * that ran THROUGH heredoc bodies. One unbalanced `)` in prose therefore
 * closed the span early and the rest of a PR description leaked into the
 * top-level command scan (round 2's own PR body was denied by its own
 * hook). The lesson is structural, not a missing case: span extents and
 * heredoc bodies cannot be decided by two separate scanners.
 *
 * So there is now exactly ONE region pass, {@link lexRegions}, which is
 * simultaneously quote-, comment-, heredoc- and substitution-aware and
 * calls ITSELF to find a nested span's extent. It returns
 *
 *   - `retained`: the text left after every INERT region is subtracted, and
 *   - a flat list of every command-substitution body at any depth,
 *
 * and only then does {@link splitSegments} split on operators (it has to
 * know about quotes and nothing else, because substitutions, heredoc
 * bodies and comments are already gone). A stray `)`/backtick inside a
 * heredoc body is unreachable by construction rather than special-cased.
 *
 * The regions are classified from REAL bash, empirically -- every
 * (region kind × nesting context) cell of the state space was run through
 * `bash -c` with a side-effecting stand-in for the forbidden command, and
 * the cell's verdict is whether the side effect happened. The full table,
 * with the fixture id that pins each cell, is in the PR body and in
 * `tests/scripts/guard-bash-hook.test.ts`'s `LEXER_STATE_SPACE`. The three
 * results that are easy to get backwards from reading code alone:
 *
 *   - A heredoc body with a QUOTED delimiter (`<<'EOF'`, `<<"EOF"`,
 *     `<<\EOF`) is inert in full and is dropped.
 *   - A heredoc body with an UNQUOTED delimiter (`<<EOF`) is NOT inert:
 *     bash still expands `$( … )` and backticks inside it, so
 *     `cat <<EOF` / `$(git stash)` / `EOF` really runs it. Its body text is
 *     dropped but its substitutions are recursed into.
 *   - Quotes and `#` are LITERAL inside any heredoc body -- so
 *     `'$(git stash)'` and `# $(git stash)` on a body line both still run.
 *
 * A single-quoted span is deliberately NOT subtracted. It is inert for
 * operator splitting, expansion, and comment/heredoc recognition, but it
 * still takes part in WORD formation: `git 'stash'` and `'git' stash` both
 * really run `git stash`. It is retained as literal word text instead, and
 * {@link splitWords} strips the quotes when fusing the word.
 *
 * ## Handled
 *
 * `&&`, `||`, `;`, `|`, `&`, `(`, `)`, newline as segment separators;
 * single/double-quoted spans as opaque fused words; `$( … )` and backtick
 * spans, recursively (including a `\``-escaped backtick span nested inside
 * a backtick span, which bash does execute); `<<`/`<<-` heredocs with a
 * quoted, bare, or backslash-escaped delimiter, `<<-`'s leading-tab strip,
 * and a `\r` before the delimiter's newline (a CRLF command whose
 * terminator would otherwise never match, swallowing every later command);
 * `<<<` here-strings (content inert, substitutions live); `#` comments,
 * recognized only at a word start the way bash does (`a#b` is not a
 * comment); backslash-newline line continuation; a leading `{`
 * command-group brace, the shell keywords and operators that run the next
 * word (`do`, `then`, `else`, `elif`, `if`, `while`, `until`, `!`,
 * `coproc`; #3787) and `command`/`exec`/`env`/`sudo`/`time` runner
 * prefixes; `export VAR=val` persisted forward to later segments of the
 * same scan; a command word resolved by its final path segment
 * (`/usr/bin/git` == `./git` == `git`); leading `FOO=bar` env assignments
 * and the git global options that take a separate value (`-c <k>=<v>`,
 * `-C <dir>`, `--git-dir`, `--work-tree`, `--namespace`, `--config-env`,
 * `--attr-source`; #3787); a backslash-escaped command word
 * (`\g\i\t stash`, which bash runs).
 *
 * ## NOT handled (accepted; no test claims otherwise)
 *
 *   - `eval "…"`, `bash -c "…"` / `sh -c "…"`, `xargs git stash`: the
 *     nested string or spawned argv is opaque to any text scan.
 *   - A runner prefix carrying its OWN options -- `sudo -u root git stash`,
 *     `timeout 30 git stash`, `nice -n 10 git stash`, `stdbuf -o0 …`. Only
 *     the bare prefix forms above are stripped; a prefix followed by a
 *     flag stops the search (the flag becomes the command word and matches
 *     no rule).
 *   - A command word assembled by expansion (`git st$(echo a)sh`,
 *     `${G} stash`, `$(which git) stash`): no static text scan can resolve
 *     a runtime-computed word.
 *   - `require(mod)` with a variable specifier, for the probe rule.
 *   - A hook bypass spelled some other way (#3778):
 *     `GIT_CONFIG_KEY_0=core.hooksPath`, a hand edit of `.git/config`, or
 *     `git commit` through an alias. (`--no-veri`/`--no-verif` ARE matched; `--no-ver`
 *     is ambiguous, so git itself rejects it.)
 *   - `kill $(pgrep -f tlc2.TLC)` and `pgrep -f tlc2 | xargs kill` (#3556
 *     review F6): the same machine-wide kill harm `sharedKill` denies, but
 *     `pgrep` alone only lists PIDs -- nothing in this scan currently
 *     recognizes the KILLING half of that two-command shape.
 *
 * These are documented blind spots, not silent ones: the guard's threat
 * model is an agent's own slip, not a party deliberately hiding a command
 * from it.
 *
 * Never throws: any stdin/JSON/classification failure degrades to "allow"
 * (exit 0) rather than blocking every Bash call in the session -- a crashed
 * hook must never be the thing that blocks the tool. That is also what
 * bounds recursion: {@link lexRegions} nests once per nested span, and a
 * pathologically deep input raises RangeError, which {@link run} catches
 * and allows. (Round 2 capped nesting at depth 8, which silently ALLOWED
 * anything nested deeper; the cap is deleted rather than raised.)
 */
import {
	existsSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
	writeSync,
} from "node:fs";
import {
	dirname,
	isAbsolute,
	join,
	basename,
	relative,
	resolve,
	sep as SEP,
} from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {"stash"|"reset"|"worktreeForce"|"worktreeSymlink"|"probe"|"tmpdirCollision"|"sharedKill"|"tmpCheckout"|"checkUngated"|"hookBypass"|"forcePush"|"ciVerdictStatus"|"rebase"} DenyRule */

/** @type {Record<DenyRule, string>} */
export const RULE_MESSAGES = {
	stash:
		"git stash is forbidden (CLAUDE.md non-negotiable) -- it is repo-global across worktrees; use `git diff > fix.patch` / `git checkout --` / `git apply` instead.",
	reset:
		"`git reset --soft origin/<branch>` / `git reset --hard` is forbidden (fixer playbook rule) -- use `git checkout HEAD -- <path>` to discard a single file instead.",
	worktreeForce:
		"a HAND-typed `git worktree remove` with two force flags is forbidden (fixer playbook rule) -- use `node scripts/prune-agent-worktrees.mjs` (liveness-checked; it applies the same double force internally once a tree is confirmed dead) for a stuck worktree, or `git worktree unlock` then a single-force remove.",
	worktreeSymlink:
		"git worktree remove on a tree whose node_modules is a symlink into another checkout is forbidden (#3173, the #2704 class -- git follows the link and empties the SHARED install, not just this worktree's copy) -- unlink it first: `rm <tree>/node_modules` (removes only the symlink, not the shared install), then retry the remove; if it is a directory, remove only that worktree copy after confirming the main checkout is intact.",
	probe:
		"an unpinned node probe that LOADS runtime code from clients/ or dist/ is forbidden (AGENTS.md Probe hygiene) -- prefix `PI_LENS_HOME=<worktree>/.probe-home`.",
	tmpdirCollision:
		"TMPDIR/TMP/TEMP must not point at the vitest harness home (AGENTS.md Probe hygiene) -- tests/support/vitest-setup.ts keeps the real TMPDIR on purpose and mkdtemps PI_LENS_HOME under os.tmpdir(), so a TMPDIR inside `.probe-home` moves the harness home into a git-ignored directory in the worktree and reds unrelated suites (#3026). Pin PI_LENS_HOME/PILENS_DATA_DIR there; give TMPDIR its own directory.",
	sharedKill:
		"pkill/killall with a bare (unscoped) pattern is forbidden (#3556) -- it matches machine-wide and can kill another concurrent session's TLC/vitest/etc run on this shared host -- kill the recorded PID of your own background job instead (`kill <pid>`), or use `pkill -f` with a pattern that includes your worktree's absolute path so only your own processes match.",
	tmpCheckout:
		"a checkout or scratch directory under /tmp is forbidden (#3526) -- /tmp on the maintainer host is tmpfs (RAM + swap; #2912 saw inode exhaustion there) and review/merge scratch checkouts filled it to 8/8 GB swap -- use `~/.local/share/pi-lens-orchestrator/tmp/<lane>` for orchestrator/reviewer scratch, `<worktree>/../probes-<pr>` for probe files, or `.claude/worktrees/` for a fixer's own worktree.",
	hookBypass:
		"bypassing git hooks (`--no-verify`, `git commit -n`, `-c core.hooksPath=`, `git config core.hooksPath`, `HUSKY=0`, `PI_LENS_SKIP_HOOKS=`) is forbidden (#3778; #3703 pushed `--no-verify` and put 56 red files into CI) -- hooks always run; for a red that looks unrelated, prove it with `node scripts/red-on-base.mjs` and, unless it says RED-ON-BASE, fix it; if it does, stop and hand back its output instead of pushing past it; to repair a wrong `core.hooksPath`, run `node scripts/setup-git-hooks.mjs`.",
	checkUngated:
		"a `git commit`/`git push` chained after a check (`npm run lint`/`build`/`test`/`fmt:check`/`preflight`, `npx vitest`, `tsc`, `node scripts/check-*.mjs`) through `;` or a pipe, rather than `&&`, is forbidden (#3471) -- the check's exit code gates nothing that way, so a real failure can still get committed or pushed; gate it with `&&`, or read the check's result in its own separate call.",
	forcePush:
		"force-pushing is forbidden -- merge `origin/master` instead; force-push needs explicit orchestrator authorization with `--force-with-lease=<branch>:<expected-sha>`.",
	rebase:
		"`git rebase` is forbidden -- merge `origin/master` instead; recovery may use `git rebase --abort` or `--quit`.",
	ciVerdictStatus:
		"ci-verdict's exit status is lost through a pipe -- read the final `ci-verdict: exit <N> (<kind>)` line, or run `; echo $?` before the pipe; do not read `$?` after `ci-verdict.mjs … | …` (#3883).",
};

/**
 * Characters after which a `#` starts a comment and a new word begins --
 * bash's own rule (a `#` in the MIDDLE of a word, `a#b`, is literal). Also
 * terminates a bare heredoc delimiter. `(`/`)` are deliberately NOT members:
 * adding them was mutation-inert (round 3's M14 stayed green), and inside a
 * `$( … )` body {@link lexRegions} already sets the word-start flag on those
 * two characters explicitly.
 */
const WORD_BREAK = /[\s;&|<>]/;

/**
 * Segment separators in the retained text. Single characters only: `&&`
 * and `||` fall out as two consecutive separators with nothing between
 * them, which {@link splitSegments} discards. `(` and `)` are here because
 * bash treats them as metacharacters that delimit commands, which is what
 * makes `(git stash)` and `( cd x && git stash )` reachable.
 */
const SEGMENT_SEPARATOR = /[;&|()\n]/;

/**
 * Is `text[i]` (already known to match {@link SEGMENT_SEPARATOR}) actually a
 * live separator, or a `&` that is part of a REDIRECTION rather than the
 * background operator / half of `&&`? Found while building #3471's
 * `checkUngated` rule: `npm run lint >/dev/null 2>&1 && git commit …` (the
 * issue's own case 1, rewritten with `&&` -- exactly the form the rule must
 * ALLOW) split into three bogus segments ("…2>", "1", "… git commit …")
 * because the lone `&` inside `2>&1` matched {@link SEGMENT_SEPARATOR}
 * unconditionally; the accumulated separator text on the segment after it
 * happened to still read "&&" only by coincidence of THIS example's spacing,
 * which is exactly why measuring caught it, not code review. MEASURED
 * against real bash (`bash -c 'echo A 2>&1 && echo B'`, `'echo A >f 2>&1 &&
 * echo B'`, `'echo A &> f && echo B'`, `'echo A 1>&2 && echo B'`, all in the
 * PR body): `N>&M`/`>&M`/`<&M` (an fd-duplication target) and `&>`/`&>>`
 * (bash's redirect-both form) are single redirection tokens, never a
 * background operator or half of `&&` -- the following `&&` still gates on
 * the command BEFORE the redirection, not split by it. Detected the same
 * way a heredoc delimiter already is elsewhere in this file: by the RAW
 * source characters immediately before/after `text[i]`, which segment
 * splitting can read directly without a separate quote/comment-aware pass
 * (this scan only ever runs after {@link lexRegions} has already resolved
 * quotes, comments, and substitutions, so no quoted `&` reaches here).
 *
 * @param {string} text
 * @param {number} i
 * @returns {boolean}
 */
function isLiveSeparator(text, i) {
	const ch = text[i];
	if (!SEGMENT_SEPARATOR.test(ch)) return false;
	if (
		ch === "&" &&
		(text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")
	)
		return false;
	return true;
}

/**
 * Characters a backslash escapes INSIDE a double-quoted span (bash: every
 * other backslash there is literal).
 */
const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', "\\", "$", "`"]);

/**
 * Parse a `<<`/`<<-` heredoc operator's delimiter, starting just after the
 * two `<` characters. A delimiter is "quoted" -- meaning bash performs NO
 * expansion in the body -- if any part of it is single-quoted,
 * double-quoted, or backslash-escaped (`<<'EOF'`, `<<"EOF"`, `<<\EOF`,
 * `<<EO'F'` all qualify). An empty delimiter (malformed `<<`) is reported
 * as `null` so the caller treats the `<<` as ordinary text instead of
 * starting a heredoc.
 *
 * @param {string} text
 * @param {number} start index just after "<<"
 * @returns {{ delimiter: string | null; stripTabs: boolean; quoted: boolean; end: number }}
 */
function parseHeredocMarker(text, start) {
	let i = start;
	let stripTabs = false;
	if (text[i] === "-") {
		stripTabs = true;
		i++;
	}
	while (text[i] === " " || text[i] === "\t") i++;
	let delimiter = "";
	let quoted = false;
	while (i < text.length && !WORD_BREAK.test(text[i])) {
		const ch = text[i];
		if (ch === "'" || ch === '"') {
			quoted = true;
			i++;
			while (i < text.length && text[i] !== ch) {
				delimiter += text[i];
				i++;
			}
			if (text[i] === ch) i++;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			quoted = true;
			delimiter += text[i + 1];
			i += 2;
			continue;
		}
		delimiter += ch;
		i++;
	}
	return { delimiter: delimiter || null, stripTabs, quoted, end: i };
}

/**
 * Scan an UNQUOTED-delimiter heredoc body for the only two things bash
 * still executes inside one: `$( … )` and backtick command substitution.
 * Quotes and `#` are LITERAL here (verified against real bash --
 * `cat <<EOF` / `'$(git stash)'` / `EOF` and `# $(git stash)` on a body
 * line both run), so this scan deliberately does NOT track quote or
 * comment state; a backslash still escapes the next character.
 *
 * @param {string} body
 * @param {string[]} out flat sink for every substitution body found
 */
function scanHeredocBodyForSubstitutions(body, out) {
	/** @type {string[]} */
	const found = [];
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (ch === "\\" && i + 1 < body.length) {
			i += 2;
			continue;
		}
		if (ch === "$" && body[i + 1] === "(") {
			/** @type {string[]} */
			const spanFound = [];
			const span = lexRegions(body, i + 2, ")", spanFound);
			if (!span.closed) {
				out.push(...found);
				return;
			}
			found.push(...spanFound);
			found.push(span.retained);
			i = span.end;
			continue;
		}
		if (ch === "`") {
			/** @type {string[]} */
			const spanFound = [];
			const span = lexRegions(body, i + 1, "`", spanFound);
			if (!span.closed) {
				out.push(...found);
				return;
			}
			found.push(...spanFound);
			found.push(span.retained);
			i = span.end;
			continue;
		}
		i++;
	}
	out.push(...found);
}

/**
 * Consume one heredoc body, starting just after the newline that triggered
 * it, and DROP it: body lines are never tokenized as commands (a PR
 * description, an issue comment, a file written through `cat <<'EOF' … EOF`
 * is data, not a command line). A body whose delimiter was UNQUOTED is
 * first handed to {@link scanHeredocBodyForSubstitutions}, because bash
 * does expand `$( )`/backticks there.
 *
 * The delimiter line is matched with `<<-`'s leading tabs stripped and with
 * a trailing `\r` tolerated: a CRLF command text whose terminator never
 * matches makes the body run to end-of-text and silently swallows every
 * later command, which is a false ALLOW -- the one direction this guard
 * must never fail in.
 *
 * @param {string} text
 * @param {number} start
 * @param {{ delimiter: string; stripTabs: boolean; quoted: boolean }} heredoc
 * @param {string[]} out
 * @returns {number} index just past the delimiter line's newline (or EOF)
 */
function consumeHeredocBody(text, start, heredoc, out) {
	let i = start;
	while (i <= text.length) {
		const nl = text.indexOf("\n", i);
		const lineEnd = nl === -1 ? text.length : nl;
		let line = text.slice(i, lineEnd);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
		if (line === heredoc.delimiter) {
			if (!heredoc.quoted)
				scanHeredocBodyForSubstitutions(text.slice(start, i), out);
			return nl === -1 ? lineEnd : lineEnd + 1;
		}
		if (nl === -1) break;
		i = lineEnd + 1;
	}
	if (!heredoc.quoted) scanHeredocBodyForSubstitutions(text.slice(start), out);
	return text.length;
}

/**
 * THE region pass. Walks `text` from `start` until `closer` (`")"` for a
 * `$( … )` body, `` "`" `` for a backtick body, or `null` for end-of-text),
 * returning the text left once every inert region is subtracted, and
 * pushing every command-substitution body it finds -- at any depth, since
 * it recurses into itself to find a nested span's extent -- into `out`.
 *
 * Because the SAME pass decides span extents and consumes heredoc bodies,
 * a `)` or a backtick inside a heredoc body can never close an enclosing
 * span (#2699 review round 2's V1). That is a property of the shape, not a
 * case that was remembered.
 *
 * Subtracted: comments, heredoc bodies, and substitution bodies (the last
 * are re-scanned via `out`, not discarded). Retained: everything else,
 * including single- and double-quoted spans with their quote characters,
 * so word formation downstream is unaffected.
 *
 * @param {string} text
 * @param {number} start
 * @param {")"|"`"|null} closer
 * @param {string[]} out
 * @returns {{ end: number; retained: string; closed: boolean }}
 */
function lexRegions(text, start, closer, out) {
	let retained = "";
	let i = start;
	/** @type {"single"|"double"|null} */
	let quote = null;
	/** Nested plain `(`/`)` inside a `$( … )` body, so `$(( … ))` closes correctly. */
	let parenDepth = 0;
	let atWordStart = true;
	/** Heredoc markers seen on the current line, consumed in order at its newline. */
	/** @type {Array<{ delimiter: string; stripTabs: boolean; quoted: boolean }>} */
	let pendingHeredocs = [];
	while (i < text.length) {
		const ch = text[i];
		if (quote === "single") {
			retained += ch;
			if (ch === "'") quote = null;
			i++;
			continue;
		}
		if (quote === "double") {
			if (ch === "\\" && text[i + 1] === "\n") {
				i += 2;
				continue;
			}
			if (ch === "\\" && DOUBLE_QUOTE_ESCAPABLE.has(text[i + 1])) {
				retained += ch + text[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') {
				quote = null;
				retained += ch;
				i++;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(") {
				const span = lexRegions(text, i + 2, ")", out);
				out.push(span.retained);
				i = span.end;
				continue;
			}
			if (ch === "`") {
				i = collectBacktickSpan(text, i, out);
				continue;
			}
			retained += ch;
			i++;
			continue;
		}
		if (closer === ")" && ch === ")") {
			if (parenDepth === 0) return { end: i + 1, retained, closed: true };
			parenDepth--;
			retained += ch;
			atWordStart = true;
			i++;
			continue;
		}
		if (closer === ")" && ch === "(") {
			parenDepth++;
			retained += ch;
			atWordStart = true;
			i++;
			continue;
		}
		if (closer === "`" && ch === "`")
			return { end: i + 1, retained, closed: true };
		if (ch === "\\" && text[i + 1] === "\n") {
			i += 2;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			// An escaped character is never special -- and the backslash is
			// KEPT here so a later `\$(`/`\#` is not re-read as live syntax;
			// splitWords drops it when forming the word.
			retained += ch + text[i + 1];
			atWordStart = false;
			i += 2;
			continue;
		}
		if (ch === "#" && atWordStart) {
			const nl = text.indexOf("\n", i);
			i = nl === -1 ? text.length : nl;
			continue;
		}
		if (ch === "<" && text[i + 1] === "<" && text[i + 2] === "<") {
			// A here-string is a redirection with one word of input, not a
			// heredoc marker. Consume all three '<' characters so the third
			// one cannot be re-read as the start of a phantom delimiter.
			retained += "<<<";
			atWordStart = false;
			i += 3;
			continue;
		}
		if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
			const marker = parseHeredocMarker(text, i + 2);
			if (marker.delimiter !== null) {
				pendingHeredocs.push({
					delimiter: marker.delimiter,
					stripTabs: marker.stripTabs,
					quoted: marker.quoted,
				});
				retained += text.slice(i, marker.end);
				atWordStart = false;
				i = marker.end;
				continue;
			}
		}
		if (ch === "\n" && pendingHeredocs.length > 0) {
			retained += "\n";
			let pos = i + 1;
			for (const heredoc of pendingHeredocs)
				pos = consumeHeredocBody(text, pos, heredoc, out);
			pendingHeredocs = [];
			atWordStart = true;
			i = pos;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			const span = lexRegions(text, i + 2, ")", out);
			out.push(span.retained);
			atWordStart = false;
			i = span.end;
			continue;
		}
		if (ch === "`") {
			i = collectBacktickSpan(text, i, out);
			atWordStart = false;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			retained += ch;
			atWordStart = false;
			i++;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			retained += ch;
			atWordStart = false;
			i++;
			continue;
		}
		retained += ch;
		atWordStart = WORD_BREAK.test(ch);
		i++;
	}
	return { end: i, retained, closed: closer === null };
}

/**
 * Collect one backtick span that starts at `text[open]`, pushing its body
 * into `out` and returning the index just past its closing backtick.
 *
 * The extent comes from {@link lexRegions} (heredoc- and quote-aware, so a
 * heredoc body inside the span cannot close it early). The one thing a
 * backtick span needs on top: bash requires a NESTED backtick span to be
 * written `` \` ``, and it does execute it -- so when the body carries an
 * escaped backtick, the escape is undone and the body re-lexed, which
 * surfaces the inner substitution. Only `` \` `` is undone; `\$` and `\\`
 * are left alone, since undoing those would invent substitutions bash
 * treats as literal.
 *
 * @param {string} text
 * @param {number} open index of the opening backtick
 * @param {string[]} out
 * @returns {number}
 */
function collectBacktickSpan(text, open, out) {
	const span = lexRegions(text, open + 1, "`", out);
	if (span.retained.includes("\\`")) {
		const unescaped = span.retained.replace(/\\`/g, "`");
		const nested = lexRegions(unescaped, 0, null, out);
		out.push(nested.retained);
	} else {
		out.push(span.retained);
	}
	return span.end;
}

/**
 * Every region of `commandText` that bash can EXECUTE, as raw text ready
 * for {@link splitSegments}. Index 0 is the top level; the rest are
 * command-substitution bodies (from anywhere, including inside an
 * unquoted-delimiter heredoc body), already flattened, already stripped of
 * their own inert regions.
 *
 * @param {string} commandText
 * @returns {string[]}
 */
export function scannableRegions(commandText) {
	/** @type {string[]} */
	const substitutions = [];
	const { retained } = lexRegions(commandText, 0, null, substitutions);
	return [retained, ...substitutions];
}

/**
 * Split one scannable region into simple-command segments -- a one-line map
 * over {@link splitSegmentsWithSeparators} (#3526 review S2: the two lexer
 * bodies were near-duplicates, 0 diffs measured over the full 1,850-region
 * transcript corpus, and after `checkUngated` this function has no
 * production caller left -- {@link findDeny} uses the separator-tagged
 * version -- so the 5 redirection tests pinning `splitSegments`'s own
 * output now exercise the SAME lexer the hook actually runs, not a stale
 * duplicate of it).
 *
 * @param {string} region
 * @returns {string[]}
 */
export function splitSegments(region) {
	return splitSegmentsWithSeparators(region).map((s) => s.text);
}

/**
 * Split one segment into words: whitespace-separated outside quotes. A
 * quoted span fuses into the surrounding word rather than splitting on
 * internal whitespace, and its quote characters are stripped -- so
 * `echo "git stash"` yields the two words `echo` and `git stash` (one
 * opaque argument), while `git 'stash'` correctly yields `git` and
 * `stash`. Outside quotes a backslash escapes the next character and is
 * dropped, matching bash -- `\g\i\t stash` really does run `git stash`.
 *
 * @param {string} segment
 * @returns {string[]}
 */
export function splitWords(segment) {
	/** @type {string[]} */
	const words = [];
	let buf = "";
	/** @type {"single"|"double"|null} */
	let quote = null;
	let started = false;
	let i = 0;
	const flush = () => {
		if (started) words.push(buf);
		buf = "";
		started = false;
	};
	while (i < segment.length) {
		const ch = segment[i];
		if (quote === "single") {
			started = true;
			if (ch === "'") {
				quote = null;
				i++;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}
		if (quote === "double") {
			started = true;
			if (ch === "\\" && DOUBLE_QUOTE_ESCAPABLE.has(segment[i + 1])) {
				buf += segment[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') {
				quote = null;
				i++;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < segment.length) {
			started = true;
			buf += segment[i + 1];
			i += 2;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			i++;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			started = true;
			i++;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			started = true;
			i++;
			continue;
		}
		started = true;
		buf += ch;
		i++;
	}
	flush();
	return words;
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Strip leading `FOO=bar` env assignments from a word list, returning the
 * assignments (for the PI_LENS_HOME probe rule) and the remaining
 * command+args words.
 *
 * @param {string[]} words
 * @returns {{ env: Record<string, string>; rest: string[] }}
 */
export function stripEnvAssignments(words) {
	/** @type {Record<string, string>} */
	const env = {};
	let i = 0;
	while (i < words.length) {
		const m = ENV_ASSIGNMENT.exec(words[i]);
		if (!m) break;
		env[m[1]] = m[2];
		i++;
	}
	return { env, rest: words.slice(i) };
}

/** Global git flags that consume a SEPARATE following token as their value
 *  (#3787, each probed against git 2.53: `--exec-path` takes its value only
 *  as `=`, and `--super-prefix` is rejected as an unknown option). */
const GIT_TWO_TOKEN_FLAGS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
]);

/**
 * Does `dir` look like a git WORKTREE checkout -- checked the same way git
 * itself tells a linked worktree apart from the main repository: only a
 * linked worktree's top-level `.git` is a FILE whose content starts with
 * `gitdir:` (the main checkout's `.git` is a directory; an ordinary
 * directory that happens to share a name has no `.git` at all). Never
 * throws: a missing `.git`, or `readFileSync` on it failing for ANY reason
 * -- ENOENT, or EISDIR (reading a directory as a file, exactly what the
 * MAIN checkout's own `.git` is) -- both land in the one catch below, so
 * it is simply "not a worktree" -- acceptance #3, a path that is not a
 * worktree is left to git, never a false deny. A separate `lstatSync`
 * "is this a file?" pre-check was tried and DELETED: `readFileSync`
 * already throws EISDIR for exactly the directory case that pre-check
 * existed to catch (measured directly: `fs.readFileSync` on a real
 * directory throws `EISDIR`), so the pre-check never changed the verdict
 * and mutating it out left every test in thi…8798 tokens truncated…		a === "-p" ||
			a === "--input-type" ||
			a.startsWith("--input-type="),
	);
	const fileArg = args.find(
		(a) => !a.startsWith("-") && /\.(?:mjs|js)$/.test(a),
	);
	const fileArgLoadsRuntimeCode =
		fileArg !== undefined &&
		(fileArgUnderDir(fileArg, "clients") || fileArgUnderDir(fileArg, "dist")) &&
		loadsPiLensRuntime(fileArg, cwd, initialIdentity);
	const evalPayloadLoadsRuntimeCode =
		hasFlag &&
		[...rawSegment.matchAll(RUNTIME_LOAD_PATTERN)].some((match) =>
			loadsPiLensRuntime(match[1] ?? match[2], cwd, initialIdentity),
		);
	if (!fileArgLoadsRuntimeCode && !evalPayloadLoadsRuntimeCode) return null;
	if ("PI_LENS_HOME" in env) return null;
	if ("PI_LENS_HOME" in process.env) return null;
	return "probe";
}

/**
 * The environment variables Node's `os.tmpdir()` consults. MEASURED, not
 * assumed -- one child process per variable on node v22.22.1 (this repo's
 * runtime), Linux: `TMPDIR=/a` -> `/a`, `TMP=/b` -> `/b`, `TEMP=/c` ->
 * `/c`, all three set -> `/a`, none -> `/tmp`. All three reach the harness,
 * so the guard covers all three rather than only the one the incident used.
 */
const TEMP_DIR_VARS = ["TMPDIR", "TMP", "TEMP"];

/**
 * The directory name AGENTS.md "Probe hygiene" prescribes for a pinned
 * `PI_LENS_HOME` (and the {@link RULE_MESSAGES}.probe message hands out).
 */
const HARNESS_HOME_SEGMENT = ".probe-home";

/** `$PI_LENS_HOME` / `${PI_LENS_HOME}` -- the same directory under its
 *  variable spelling, which is what an agent reaches for right after
 *  reading the `probe` rule's message. The name boundary matters: without
 *  it `$PI_LENS_HOME_TMP` and `$PI_LENS_HOMEDIR/x` -- different variables,
 *  naming different directories -- were both denied (review round 2 T3). */
const HARNESS_HOME_VARIABLE =
	/\$\{PI_LENS_HOME\}|\$PI_LENS_HOME(?![A-Za-z0-9_])/;

/**
 * Deny a `TMPDIR`/`TMP`/`TEMP` assignment that aims Node's temp directory
 * at the vitest harness's own `PI_LENS_HOME` (#3026, 2026-09-15).
 *
 * `tests/support/vitest-setup.ts` deliberately keeps the REAL `TMPDIR` and
 * mkdtemps the per-worker `PI_LENS_HOME` under `os.tmpdir()`. Point
 * `TMPDIR` at `<worktree>/.probe-home` and that home lands inside the
 * checkout, in a directory `.gitignore` ignores -- so every suite whose
 * fixtures live under `os.tmpdir()` is suddenly reading ignored paths. The
 * #3026 fixer did exactly that and reported "16 suites red on
 * origin/master"; the tree was green. Measured again on this branch:
 * `tests/clients/ext-gate-before-ignore.test.ts` is 8/8 green with TMPDIR
 * elsewhere and 7 failed / 1 passed with `TMPDIR=$PWD/.probe-home`, same
 * build, same tree.
 *
 * Matching is by path SEGMENT ({@link fileArgUnderDir}), never substring,
 * so `$PWD/.probe-home`, `/abs/.probe-home` and `.probe-home/sub` all
 * match while `.probe-home-2` does not.
 *
 * Known limit (review round 2): the offending path has to appear in the
 * assignment's own text. A third variable hides it --
 * `export PROBE_HOME=$PWD/.probe-home; export TMPDIR=$PROBE_HOME` allows,
 * because resolving it would mean evaluating the shell's variable
 * environment, which this static scan does not do (the same class as the
 * header's "command word assembled by expansion" blind spot).
 *
 * @param {Record<string, string>} env
 * @returns {DenyRule | null}
 */
function classifyTempDirVars(env) {
	for (const name of TEMP_DIR_VARS) {
		const value = env[name];
		if (value === undefined) continue;
		if (fileArgUnderDir(value, HARNESS_HOME_SEGMENT)) return "tmpdirCollision";
		if (HARNESS_HOME_VARIABLE.test(value)) return "tmpdirCollision";
	}
	return null;
}

/**
 * Words that just mean "run the following command", stripped before the
 * command word is identified. `command`/`exec`/`env` came from review
 * round 2 F7; `sudo`/`time` from round 3's V5 (both confirmed against real
 * bash to run their argument). Only the BARE forms are handled -- a prefix
 * carrying its own options (`sudo -u root`, `nice -n 10`, `timeout 30`) is
 * in the header's NOT-handled list.
 */
const RUNNER_PREFIX_WORDS = new Set(["command", "exec", "env", "sudo", "time"]);

/**
 * Reserved words and operators after which bash runs the NEXT word as a
 * command (#3787, each probed in bash 5.3: the side effect happened). Not
 * `case`/`esac`/`fi`/`done`/`in`/`select`: they run nothing at that word, and
 * a `case` arm is split off by its `)`.
 */
const COMMAND_KEYWORDS = new Set([
	"{",
	"!",
	"do",
	"then",
	"else",
	"elif",
	"if",
	"while",
	"until",
	"coproc",
]);

/**
 * Strip any leading `{` brace, shell keyword ({@link COMMAND_KEYWORDS}) and
 * runner-prefix words, in any order and repeated, so `command env git stash`,
 * `{ sudo git stash` and `do git stash` all resolve to `git stash`. `env`'s
 * own `FOO=bar` assignments (if any) still parse correctly afterward via
 * {@link stripEnvAssignments} once `env` itself is dropped.
 *
 * @param {string[]} words
 * @returns {string[]}
 */
function stripCommandGroupAndRunnerPrefixes(words) {
	let i = 0;
	while (i < words.length) {
		if (words[i] === "coproc") {
			// A coprocess may have an optional name before a brace command
			// group: `coproc C { git stash; }`. Strip that name only when
			// the following brace makes the form unambiguous; the ordinary
			// `coproc git stash` keeps `git` as the command word.
			if (words[i + 1] === "{") {
				i++;
				continue;
			}
			if (
				words[i + 2] === "{" &&
				/^[A-Za-z_][A-Za-z0-9_]*$/.test(words[i + 1] ?? "")
			) {
				i += 2;
				continue;
			}
		}
		if (COMMAND_KEYWORDS.has(words[i]) || RUNNER_PREFIX_WORDS.has(words[i])) {
			i++;
			continue;
		}
		break;
	}
	return words.slice(i);
}

/**
 * The final path segment of a command word -- so `/usr/bin/git`, `./git`,
 * and `git` all resolve to the same command name (#2699 review round 2 F7).
 *
 * @param {string} cmd
 * @returns {string}
 */
function commandBasename(cmd) {
	const idx = Math.max(cmd.lastIndexOf("/"), cmd.lastIndexOf("\\"));
	return idx === -1 ? cmd : cmd.slice(idx + 1);
}

/**
 * Classify one segment. `sharedEnv` carries `export VAR=val` (or a
 * standalone `VAR=val` with no command on the same segment) assignments
 * forward to LATER segments in the same {@link findDeny} scan (#2699 review
 * round 2 F2: AGENTS.md sanctions `export PI_LENS_HOME=<worktree>/.probe-home`
 * as an earlier `;`/newline-separated segment, not only as this segment's
 * own prefix or `process.env`). The `export` builtin NEVER runs a trailing
 * command in real bash -- any word after its assignments is another (bare)
 * name marked for export, not a command -- so a segment starting with
 * `export` always terminates here, persisting into `sharedEnv` (mutated in
 * place) and returning `null`. A NON-exported `FOO=bar cmd` prefix, by
 * contrast, applies only to THIS segment's own command (matching real
 * bash), merged into the `effectiveEnv` passed to {@link classifyNode}.
 *
 * @param {string} rawSegment
 * @param {Record<string, string>} sharedEnv
 * @param {string} [cwd] the PreToolUse payload's own cwd, for {@link classifyGit}'s worktree-path resolution
 * @returns {DenyRule | null}
 */
export function classifySegment(
	rawSegment,
	sharedEnv = {},
	cwd,
	originCwd = cwd,
) {
	const rawWords = splitWords(rawSegment);
	if (rawWords.length === 0) return null;
	const words = stripCommandGroupAndRunnerPrefixes(rawWords);
	if (words.length === 0) return null;
	if (words[0] === "export") {
		const { env: exported } = stripEnvAssignments(words.slice(1));
		Object.assign(sharedEnv, exported);
		return classifyTempDirVars(exported);
	}
	const { env: segmentEnv, rest } = stripEnvAssignments(words);
	// Before the command dispatch: the #3026 incident's own command was
	// `TMPDIR=$PWD/.probe-home npx vitest run …`, and `npx` is a command this
	// guard classifies as nothing at all. The assignment is the offence, so
	// it is judged where it is written, whatever follows it.
	const tempDirCollision = classifyTempDirVars(segmentEnv);
	if (tempDirCollision) return tempDirCollision;
	if (rest.length === 0) {
		// A standalone (non-exported) `VAR=val` with no command -- lenient:
		// persist it too (real bash would keep it a local shell variable, not
		// exported, but there is no command in this segment for the
		// distinction to matter either way).
		Object.assign(sharedEnv, segmentEnv);
		return null;
	}
	const effectiveEnv = { ...sharedEnv, ...segmentEnv };
	const cmd = commandBasename(rest[0]);
	const args = rest.slice(1);
	if (cmd === "git") return classifyGit(args, cwd, effectiveEnv);
	if (cmd === "node" || cmd === "nodejs")
		return classifyNode(
			args,
			effectiveEnv,
			rawSegment,
			cwd,
			repositoryIdentity(repositoryRoot(originCwd)),
		);
	if (cmd === "mktemp") return classifyMktemp(args, cwd, effectiveEnv);
	if (SHARED_KILL_COMMANDS.has(cmd))
		return classifyPkillKillall(cmd, args, cwd);
	return null;
}

/**
 * {@link splitSegments}'s sibling for #3471's `checkUngated` rule: the same
 * split, but each segment carries the separator text that preceded it
 * (`null` for the region's first segment). `&&`/`||` fall out of {@link
 * SEGMENT_SEPARATOR} as two consecutive single-char separators with an
 * EMPTY segment between them (splitSegments discards that empty segment;
 * here its two characters are accumulated into `pendingSep` instead of
 * being dropped, so they reach the NEXT real segment as one two-character
 * string) -- `splitSegments` itself is left untouched because existing
 * tests pin its plain string-array return shape.
 *
 * @param {string} region
 * @returns {Array<{ text: string; sep: string | null }>}
 */
export function splitSegmentsWithSeparators(region) {
	/** @type {Array<{ text: string; sep: string | null }>} */
	const segments = [];
	let buf = "";
	/** @type {"single"|"double"|null} */
	let quote = null;
	let pendingSep = "";
	let i = 0;
	const push = () => {
		if (buf.trim()) {
			segments.push({ text: buf, sep: pendingSep || null });
			pendingSep = "";
		}
		buf = "";
	};
	while (i < region.length) {
		const ch = region[i];
		if (quote === "single") {
			buf += ch;
			if (ch === "'") quote = null;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < region.length) {
			buf += ch + region[i + 1];
			i += 2;
			continue;
		}
		if (quote === "double") {
			buf += ch;
			if (ch === '"') quote = null;
			i++;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			buf += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			buf += ch;
			i++;
			continue;
		}
		if (isLiveSeparator(region, i)) {
			push();
			pendingSep += ch;
			i++;
			continue;
		}
		buf += ch;
		i++;
	}
	push();
	return segments;
}

/** `npm run <script>` scripts #3471 treats as a "check" -- named in the
 *  issue itself, not a spelling-enumerated guess. */
const CHECK_NPM_SCRIPTS = new Set([
	"lint",
	"build",
	"test",
	"fmt:check",
	"preflight",
]);

/**
 * Does `fileArg` name a `scripts/check-*.mjs` file -- segment-membership
 * check for the directory (reusing {@link fileArgUnderDir}, so a leading
 * `./` or an absolute path is still recognized) plus a basename pattern for
 * the `check-*.mjs` part.
 *
 * @param {string} fileArg
 * @returns {boolean}
 */
function isCheckScriptPath(fileArg) {
	const segments = fileArg.split(/[\\/]+/);
	const base = segments[segments.length - 1];
	return (
		fileArgUnderDir(fileArg, "scripts") && /^check-[^/\\]*\.mjs$/.test(base)
	);
}

/**
 * Classify one segment as a #3471 "check" or "write" (a `git commit`/
 * `git push`), or neither. A "check" is exactly the set the issue names:
 * `npm run (lint|build|test|fmt:check|preflight)`, `npx vitest`, `tsc`, or
 * `node scripts/check-*.mjs`.
 *
 * @param {string} rawSegment
 * @returns {"check" | "write" | null}
 */
function classifyCheckOrWrite(rawSegment) {
	const rawWords = splitWords(rawSegment);
	if (rawWords.length === 0) return null;
	// A keyword-led segment is neither (#3787): stripping `if`/`while`/`until`
	// would turn a loop's own condition into a "check" that its `;`-joined
	// `done`/`fi` never gates, and deny `until npm test; do …; done && git
	// push`. Control flow is writeIsInsideControlFlow's job here.
	if (rawWords[0] !== "{" && COMMAND_KEYWORDS.has(rawWords[0])) return null;
	const words = stripCommandGroupAndRunnerPrefixes(rawWords);
	if (words.length === 0) return null;
	const { rest: afterEnv } = stripEnvAssignments(words);
	if (afterEnv.length === 0) return null;
	// `timeout <duration> <command>…` (bare form only, no options before the
	// duration -- #3526 review F4: this repo's own vitest convention is
	// `timeout 400 node_modules/.bin/vitest run …`, and 33 corpus rows use
	// it. A `timeout` carrying its own options stops the search, the same
	// documented-blind-spot shape as this file's other runner prefixes.
	const rest = afterEnv[0] === "timeout" ? afterEnv.slice(2) : afterEnv;
	if (rest.length === 0) return null;
	const cmd = commandBasename(rest[0]);
	const args = rest.slice(1);
	if (cmd === "git") {
		const i = gitSubcommandIndex(args);
		const subcommand = args[i];
		if (subcommand === "commit" || subcommand === "push") return "write";
		return null;
	}
	if (
		cmd === "npm" &&
		((args[0] === "run" && CHECK_NPM_SCRIPTS.has(args[1])) ||
			args[0] === "test" ||
			args[0] === "t")
	)
		return "check";
	if (cmd === "npx" && args[0] === "vitest") return "check";
	// A bare `vitest`/`node_modules/.bin/vitest` (#3526 review F4: 33 corpus
	// rows use the `.bin/vitest` spelling, none of them `npx vitest`) --
	// resolved by {@link commandBasename} the same way `/usr/bin/git` already
	// resolves to `git`.
	if (cmd === "vitest") return "check";
	if (cmd === "tsc") return "check";
	if (cmd === "node" || cmd === "nodejs") {
		const scriptArg = args.find((a) => !a.startsWith("-"));
		if (scriptArg !== undefined && isCheckScriptPath(scriptArg)) return "check";
	}
	return null;
}

/**
 * Bash keywords that OPEN a control-flow construct still active at the
 * point they appear -- `then`/`elif`/`else`/`do` mark being INSIDE an
 * `if`/`while`/`until`/`for`/`case` body, and a bare `if`/`while`/`until`/
 * `case` starting a segment is the same (its own `then`/`do` may be on the
 * SAME segment, `if cond; then`, already past by the time a later segment
 * is reached). Found auditing the REAL 2026-09-07..08 transcript corpus
 * (the PR body has the transcript): this repo's own convention for running
 * a check, saving its status, and deciding afterward is `vexit=$?; …; if
 * [ $vexit -eq 0 ]; then git add … && git commit … && git push …; fi` --
 * the commit IS properly gated, just not through `&&`, and a chain scan
 * that only understands `;`/`|`/`&&` cannot tell that apart from an
 * actually-ungated write.
 */
const CONTROL_FLOW_OPENERS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"while",
	"until",
	"case",
	"do",
]);

/**
 * Bash keywords that CLOSE a control-flow construct -- `fi`/`done`/`esac`.
 * Walking backward from a write, hitting one of these before any {@link
 * CONTROL_FLOW_OPENERS} word means a construct closed BEFORE the write, so
 * it does not enclose it (#3526 review F3: `… for f in a; do :; done; git
 * push` and `… for f in a; do :; done; git push` -- an EARLIER, unrelated
 * `for…do…done` loop must not exempt a later, real ungated write; the whole-
 * region skip this replaces could not tell the difference).
 */
const CONTROL_FLOW_CLOSERS = new Set(["fi", "done", "esac"]);

/**
 * Is the write at `segments[j]` inside an unclosed control-flow construct?
 * Walks backward from `j` (the WHOLE region, not stopping at an earlier
 * write the way the check-search below does -- a shell construct's scope is
 * lexical, not reset by a completed commit/push inside it) for the nearest
 * segment whose first word is a {@link CONTROL_FLOW_OPENERS} or {@link
 * CONTROL_FLOW_CLOSERS} word. An opener found first means the write sits
 * inside that construct (own the check inside it too, so this scan stands
 * aside rather than guess at how it is really gated); a closer found first
 * means the nearest construct already ended, so it does NOT enclose the
 * write and the normal chain scan applies.
 *
 * @param {Array<{ text: string; sep: string | null }>} segments
 * @param {number} j
 * @returns {boolean}
 */
function writeIsInsideControlFlow(segments, j) {
	for (let m = j - 1; m >= 0; m--) {
		const first = segments[m].text.trim().split(/\s+/, 1)[0];
		if (first === undefined) continue;
		if (CONTROL_FLOW_CLOSERS.has(first)) return false;
		if (CONTROL_FLOW_OPENERS.has(first)) return true;
	}
	return false;
}

/**
 * #3471's `checkUngated` rule: scan one region's separator-tagged segments
 * for a `git commit`/`git push` ("write") segment whose NEAREST preceding
 * "check" segment is not connected to it by an unbroken chain of `&&`
 * separators. The backward search for that nearest check STOPS at an
 * earlier write (a completed commit/push is a fresh boundary -- #3471's own
 * proposal is about a check's result never gating ITS OWN following write,
 * not every write for the rest of the command; this is also what keeps an
 * ordinary `git commit -m x; git status` -- a sequential status check after
 * a commit, with no check anywhere -- allowed: no check precedes it at all,
 * so no write is judged).
 *
 * A `null` return for a write with NO preceding check (case 3 of #3471: a
 * bare `git push` with nothing gating it because nothing was ever supposed
 * to) is deliberate, not a gap this scan tries to close -- see the PR body
 * for why a general "a write must be command-final or &&-only" rule was
 * rejected (it denies that same sanctioned pattern).
 *
 * {@link writeIsInsideControlFlow} exempts a write PER-WRITE, not per-region
 * (#3526 review F3): a region can carry an earlier, CLOSED control-flow
 * construct (a `for…do…done` loop that finished before the check even
 * starts) alongside a later, genuinely ungated check-then-write that must
 * still deny -- a whole-region skip could not tell the two apart.
 *
 * @param {Array<{ text: string; sep: string | null }>} segments
 * @returns {DenyRule | null}
 */
function findUngatedWriteInChain(segments) {
	const shapes = segments.map((s) => classifyCheckOrWrite(s.text));
	for (let j = 0; j < segments.length; j++) {
		if (shapes[j] !== "write") continue;
		if (writeIsInsideControlFlow(segments, j)) continue;
		let k = -1;
		for (let m = j - 1; m >= 0; m--) {
			if (shapes[m] === "check") {
				k = m;
				break;
			}
			if (shapes[m] === "write") break;
		}
		if (k === -1) continue;
		let gated = true;
		for (let n = k + 1; n <= j; n++) {
			if (segments[n].sep !== "&&") {
				gated = false;
				break;
			}
		}
		if (!gated) return "checkUngated";
	}
	return null;
}

/**
 * #3883: a pipeline's `$?` is the status of its last command, not
 * ci-verdict's verdict. Recognize both orderings that make that mistake look
 * plausible: `ci-verdict | tail; echo $?`. Capturing with
 * `ci-verdict; echo $? | tail` happens before the pipe and remains allowed.
 *
 * F6 (round 2): also recognize the `timeout N node …` and
 * `node --flag …` wrappers, the `${?}` spelling, and `|&`; allow a
 * pipe-polluted `$?` once `set -o pipefail` is in force before the pipeline,
 * and allow a single-quoted `'$?'` (literal text to bash).
 *
 * @param {Array<{ text: string; sep: string | null }>} segments
 * @returns {DenyRule | null}
 */
function findPipedCiVerdictStatusRead(segments) {
	const isCiVerdict = (text) => {
		const words = stripCommandGroupAndRunnerPrefixes(splitWords(text));
		// `env FOO=bar` / `FOO=bar` before the wrapper still parse as prefixes.
		let { rest } = stripEnvAssignments(words);
		// `timeout <duration> node …` runs the node command it wraps; drop the
		// wrapper and its options/duration before looking for `node` (#3883 F6).
		// `-s`/`--signal` and `-k`/`--kill-after` each take their own argument,
		// so consume it too or the duration read lands on the signal
		// (`timeout -s KILL 600 node …`, #3883 R2).
		if (rest[0] === "timeout") {
			const takesArgument = (word) =>
				word === "-s" ||
				word === "--signal" ||
				word === "-k" ||
				word === "--kill-after";
			let i = 1;
			while (i < rest.length && rest[i].startsWith("-")) {
				i += takesArgument(rest[i]) ? 2 : 1;
			}
			i += 1; // the duration argument
			rest = rest.slice(i);
		}
		if (rest[0] !== "node" && rest[0] !== "nodejs") return false;
		// A node flag before the script path (`node --no-warnings …`) must not
		// hide it: the script is a non-flag word ending in the ci-verdict path.
		return rest
			.slice(1)
			.some(
				(word) =>
					!word.startsWith("-") &&
					/(?:^|[/\\])scripts[/\\]ci-verdict\.mjs$/.test(word),
			);
	};
	// A `$?` inside single quotes is literal text to bash, not the status; the
	// `${?}` spelling still reads it in every other context (#3883 F6). The
	// scan tracks double quotes too, so an apostrophe INSIDE a double-quoted
	// string (`echo "it's $? ok"`) does not open a phantom single-quote span
	// that hides the expansion (#3883 R2).
	const readsStatus = (text) => {
		let unquoted = "";
		let inSingle = false;
		let inDouble = false;
		for (const ch of text) {
			if (ch === "'" && !inDouble) {
				inSingle = !inSingle;
				continue;
			}
			if (ch === '"' && !inSingle) {
				inDouble = !inDouble;
				unquoted += ch;
				continue;
			}
			if (!inSingle) unquoted += ch;
		}
		return unquoted.includes("$?") || unquoted.includes("${?}");
	};
	// `set -o pipefail` makes the pipeline's `$?` the real status, so a command
	// that enables it before the pipeline is not the mistake this rule exists
	// for; `set +o pipefail` DISABLES it again, and a later disable undoes an
	// earlier enable (#3883 F6, R2).
	const pipefailSetting = (text) => {
		const { rest } = stripEnvAssignments(
			stripCommandGroupAndRunnerPrefixes(splitWords(text)),
		);
		if (rest[0] !== "set") return null;
		for (let j = 1; j < rest.length; j++) {
			const token = rest[j];
			if (!/^[-+][A-Za-z]*o$/.test(token)) continue;
			if (rest[j + 1] !== "pipefail") continue;
			return token[0] === "-";
		}
		return null;
	};
	let pipefail = false;
	for (let i = 0; i < segments.length; i++) {
		if (!isCiVerdict(segments[i].text)) {
			const setting = pipefailSetting(segments[i].text);
			if (setting !== null) pipefail = setting;
			continue;
		}
		// Only a pipefail in force BEFORE this command changes what `$?` means.
		if (pipefail) continue;
		for (let pipe = i + 1; pipe < segments.length; pipe++) {
			const sep = segments[pipe].sep;
			if (sep !== "|" && sep !== "|&") continue;
			if (segments.slice(pipe + 1).some((segment) => readsStatus(segment.text)))
				return "ciVerdictStatus";
		}
	}
	return null;
}

/**
 * Scan a full Bash command for the first denied rule: every executable
 * region {@link scannableRegions} found, split into segments and
 * classified. The top-level region runs first and accumulates `export`ed
 * assignments; each substitution region then starts from a COPY of that
 * state -- an approximation of bash's left-to-right export visibility, not
 * a fully-ordered interleaving with what appears textually inside a
 * `$( )`/backtick span (#2699 review round 2 F2). #3471's chain scan runs
 * per region too, ahead of the per-segment classification, since it needs
 * every segment of the region at once rather than one at a time.
 *
 * @param {string} commandText
 * @param {string} [cwd] the PreToolUse payload's own cwd, threaded to every segment
 * @returns {DenyRule | null}
 */
export function findDeny(commandText, cwd) {
	const regions = scannableRegions(commandText);
	/** @type {Record<string, string>} */
	const sharedEnv = {};
	for (let index = 0; index < regions.length; index++) {
		const env = index === 0 ? sharedEnv : { ...sharedEnv };
		let effectiveCwd = cwd;
		const segments = splitSegmentsWithSeparators(regions[index]);
		const ciVerdictRule = findPipedCiVerdictStatusRead(segments);
		if (ciVerdictRule) return ciVerdictRule;
		const chainRule = findUngatedWriteInChain(segments);
		if (chainRule) return chainRule;
		for (const { text: segment } of segments) {
			const rule = classifySegment(segment, env, effectiveCwd, cwd);
			if (rule) return rule;
			const words = stripCommandGroupAndRunnerPrefixes(splitWords(segment));
			if (words[0] === "cd" && words[1] && effectiveCwd) {
				const target = words[1].startsWith("~")
					? join(process.env.HOME ?? "", words[1].slice(1))
					: words[1];
				effectiveCwd = resolve(effectiveCwd, target);
			}
		}
	}
	return null;
}

/**
 * Run the guard over the PreToolUse payload. Pure (besides the
 * `PI_LENS_HOME` env read already folded into {@link classifyNode}) --
 * takes the parsed payload, returns the rule to deny for (or null to
 * allow). Exported so tests can drive it without spawning a child process
 * when they only care about classification, not the stdin/exit-code
 * plumbing.
 *
 * @param {unknown} payload
 * @returns {DenyRule | null}
 */
export function classifyPayload(payload) {
	if (!payload || typeof payload !== "object") return null;
	const p =
		/** @type {{ tool_name?: unknown; tool_input?: unknown; cwd?: unknown }} */ (
			payload
		);
	if (p.tool_name !== "Bash") return null;
	const toolInput = p.tool_input;
	if (!toolInput || typeof toolInput !== "object") return null;
	const command = /** @type {{ command?: unknown }} */ (toolInput).command;
	if (typeof command !== "string" || !command.trim()) return null;
	const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
	return findDeny(command, cwd);
}

// #3089: nothing in the stdlib waits for fd 0 to become readable
// synchronously, and a bare retry loop would spin a core while the payload
// is still arriving. `Atomics.wait` is the one sleep that yields the CPU --
// same mechanism scripts/with-memory-watch.mjs uses for its own EAGAIN
// retry on the write side.
const READ_RETRY_SLEEP_MS = 5;
const readRetryPark = new Int32Array(new SharedArrayBuffer(4));

// #3089 review round 2 F3: the three ALLOW-BY-FAILURE paths in run() below
// (empty-or-unparseable raw text, a JSON.parse failure, and this function's
// own crash guard) used to exit 0 with empty stderr -- indistinguishable
// from a genuine "nothing to check" allow, which is exactly why the
// original readFileSync(0) short read was invisible for a release cycle.
// This note fires on the two paths that saw SOME input and failed to make
// sense of it; a genuinely empty stream (nothing ever arrived, no error) is
// still silent -- that is the ordinary "hook invoked with no payload" case,
// not a failure. Used ONLY on the JSON.parse failure path -- the payload
// genuinely could not be parsed there. The crash guard (any other throw,
// including a classifier crash on a payload that WAS read and parsed fine)
// gets its own cause-bearing message instead (#3089 review round 3 N1):
// labeling a classifier crash "unreadable or unparseable" is a wrong label
// on the most important fail-open this hook has -- worse than the silence
// it replaced, because it actively misdescribes what happened.
const UNREADABLE_PAYLOAD_NOTE =
	"guard-bash: payload unreadable or unparseable; allowing\n";

// #3089 review round 3 N2: a closed or read-only stderr fd (EBADF, EPIPE,
// ...) must never turn an intended exit-0 allow into an uncaught-exception
// exit 1. `process.stderr.write` is the wrong primitive to guard here --
// verified directly: it goes through Node's Writable stream machinery,
// which never throws synchronously for an I/O failure (it reports one via
// an async `'error'` event instead), so `try { process.stderr.write(text)
// } catch {}` alone still crashed with exit 1 in the read-only-fd
// reproduction below. `fs.writeSync(2, text)` bypasses that machinery and
// writes the fd directly -- confirmed to throw EBADF SYNCHRONOUSLY for the
// same read-only fd, which a try/catch can actually catch. Every stderr
// write in this file's hook path goes through this helper so a broken
// stderr can never be the thing that blocks (or crashes) the tool -- the
// same "must never throw" promise the file's header already makes for a
// classification crash.
function note(text) {
	try {
		writeSync(2, text);
	} catch {
		// The record is lost, but losing a record must never cost the exit
		// code that record was trying to explain.
	}
}

/**
 * Read stdin synchronously, draining fd 0 to EOF. Never blocks on an
 * interactive terminal. Returns "" for a genuine empty stream (a read that
 * cleanly hits EOF on the first call, no bytes ever seen); THROWS a
 * genuine, non-retryable read error (EBADF, a closed fd, ...) instead of
 * swallowing it, so {@link run}'s own crash guard can tell "nothing to
 * read" apart from "reading failed" and note the latter (review round 2
 * F3) while keeping the never-throws contract at the run() boundary.
 *
 * #3089: `readFileSync(0, "utf8")` fails open on a payload larger than a
 * pipe buffer. Node's spawnSync sets the child's stdin pipe to
 * non-blocking once the parent starts pumping its own synchronous event
 * loop to feed `input`; a `read(2)` issued before the next chunk has
 * landed then returns EAGAIN, `readFileSync` does not retry, and the
 * thrown error was swallowed by this function's own catch-all, returning
 * "" for a payload that was still arriving. Measured on this host,
 * reproducible from ~500 KB: `spawnSync(HOOK, { input })` for a
 * >=1 MB PreToolUse JSON payload throws
 * `EAGAIN: resource temporarily unavailable, read` out of
 * `readFileSync(0, "utf8")`, and the hook exits 0 instead of denying. A
 * `read(2)` loop that retries EAGAIN (this function) and keeps
 * accumulating chunks until a read returns 0 -- true EOF, not "nothing
 * available yet" -- closes that gap regardless of how many chunks the
 * payload arrives in or how far apart in time they land.
 *
 * @returns {string}
 */
function readStdin() {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	const chunk = Buffer.alloc(65536);
	for (;;) {
		let bytesRead;
		try {
			bytesRead = readSync(0, chunk, 0, chunk.length, null);
		} catch (error) {
			if (error?.code === "EAGAIN") {
				Atomics.wait(readRetryPark, 0, 0, READ_RETRY_SLEEP_MS);
				continue;
			}
			// A read error that is not "try again" (EBADF, a closed fd, ...)
			// propagates to run()'s crash guard, which notes it and still
			// exits 0 -- never throws past that boundary.
			throw error;
		}
		if (bytesRead === 0) break; // true EOF: the writer closed its end.
		chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * @returns {number} process exit code -- 0 to allow, 2 to deny.
 */
export function run() {
	try {
		const raw = readStdin();
		if (!raw.trim()) return 0;
		/** @type {unknown} */
		let payload;
		try {
			payload = JSON.parse(raw);
		} catch {
			note(UNREADABLE_PAYLOAD_NOTE);
			return 0;
		}
		const rule = classifyPayload(payload);
		if (!rule) return 0;
		note(`${RULE_MESSAGES[rule]}\n`);
		return 2;
	} catch (error) {
		// A crash in this hook -- a genuine readStdin() read error (EBADF, a
		// closed fd, ...) OR a classifier crash on a payload that WAS read
		// and parsed fine (the #2699 r3 depth-5000 nesting case throws
		// RangeError here, not in readStdin or JSON.parse) -- must never be
		// the thing that blocks the tool, but it also must not be silently
		// indistinguishable from an ordinary allow (#3089 review round 2
		// F3), and it must not claim the payload was "unreadable or
		// unparseable" when it demonstrably was read and parsed (#3089
		// review round 3 N1) -- error.code (a read error) or error.name (a
		// RangeError, or anything else classification can throw) names the
		// actual cause instead.
		note(
			`guard-bash: ${error?.code ?? error?.name ?? "error"} while checking payload; allowing\n`,
		);
		return 0;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = run();
}
