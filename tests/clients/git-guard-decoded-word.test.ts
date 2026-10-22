// flake-shape: real-process-spawn — the oracle is real `bash -c`: whether bash runs `git commit` or `git push` for each spelling of the executable or the verb. A stubbed shell decodes nothing, and the rows exist because the matcher read token text that no shell reads (#4739).
/**
 * #4739: the `--lens-guard` commit gate reads the word bash decodes, run
 * against real bash.
 *
 * Recurrence: `$'git' push origin master` ran unguarded while `git push`,
 * `\git push` and `g""it push` were guarded, because the matcher read the
 * legacy token text (`$git`, with the `$` of the ANSI-C quote still in it).
 * Each hand-written spelling reds a different part of the word model, so the
 * rows are also generated, from the shared spelling generator (#4713 R11):
 * every quoting of the executable `git` before `push`, and of the verbs `push`
 * and `commit` after `git`.
 *
 * Each row runs through real `bash -c` with a recording stand-in for `git`
 * first on PATH (the real git never runs), then through
 * `isGitCommitOrPushAttempt`. A row passes when the gate guards exactly what
 * bash ran, or, for a row bash did not run, when it fails closed on a word the
 * model cannot read (see `ACCEPTED`).
 *
 * The fail-closed rule the table pins, in `hidesGuardedVerb`: a word the word
 * model cannot read (an ANSI-C escape, or an expansion) guards the command
 * when it precedes a word that is, or may be, `commit` or `push`; when it is
 * git's own verb; or, for an ANSI-C escape, when a shell or `eval` receives it.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	decodeShellWords,
	scanShellWriteScopes,
	tokenizeShellCommand,
} from "../../clients/bash-file-access.js";
import {
	isGitCommitOrPushAttempt,
	collectGitInvocations,
} from "../../clients/git-guard.js";
import { isFailedGitIntegrationCommand } from "../../clients/runtime-tool-result.js";
import { isWorktreeMutatingGitAttempt } from "../../clients/shared-checkout-guard.js";
import { COMMAND_WRAPPERS, spellings } from "../support/shell-spellings.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { removeTempDirSync } from "./test-utils.js";

interface Row {
	row: string;
	command: string;
	/** The verb real bash ran, or `null`: pinned against the oracle. */
	bash: "commit" | "push" | null;
	guard: boolean;
}

/** The acceptance spellings, and the fail-closed rows, one per rule clause. */
const ROWS: readonly Row[] = [
	{ row: "plain", command: "git push", bash: "push", guard: true },
	{
		row: "ANSI-C executable",
		command: "$'git' push origin master",
		bash: "push",
		guard: true,
	},
	{
		row: "locale executable",
		command: '$"git" push',
		bash: "push",
		guard: true,
	},
	{
		row: "mixed executable",
		command: "g$'i't push",
		bash: "push",
		guard: true,
	},
	{
		row: "escaped $ is a literal word",
		command: "\\$'git' push",
		bash: null,
		guard: false,
	},
	{
		row: "ANSI-C executable, commit",
		command: "FOO=1 $'git' commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		row: "ANSI-C verb",
		command: "git $'push'",
		bash: "push",
		guard: true,
	},
	{
		row: "mixed verb",
		command: "git pu$'sh'",
		bash: "push",
		guard: true,
	},
	{
		row: "ANSI-C executable behind a launcher",
		command: "env $'git' push",
		bash: "push",
		guard: true,
	},
	{
		row: "ANSI-C executable in a shell string",
		command: "bash -c $'git push'",
		bash: "push",
		guard: true,
	},
	{
		// The close of `$'\''` is its LAST quote: reading the second as the
		// close swallowed the rest of the line (#4739).
		row: "escaped quote in ANSI-C, then git",
		command: ": $'\\'' ; git push",
		bash: "push",
		guard: true,
	},
	{
		row: "escaped quote in ANSI-C, then git, after text",
		command: "echo $'it\\'s' && git push",
		bash: "push",
		guard: true,
	},
	{
		// The substitution scanner ended the string at the escaped quote too.
		row: "escaped quote in ANSI-C, then a substitution",
		command: "echo $'\\'' $(git push)",
		bash: "push",
		guard: true,
	},
	{
		// The body scanner ended the string at the escaped quote and lost the `)`.
		row: "escaped quote in ANSI-C inside a substitution",
		command: "echo $(: $'\\'' ; git push)",
		bash: "push",
		guard: true,
	},
	{
		// So did the `$IFS` pass: it read `git${IFS}push` as quoted text.
		row: "escaped quote in ANSI-C, then git${IFS}push",
		command: ": $'\\'' ; git${IFS}push",
		bash: "push",
		guard: true,
	},
	{
		// bash removes the backslash; the path reading kept it (#4739).
		row: "escaped letter in the executable",
		command: "g\\it push",
		bash: "push",
		guard: true,
	},
	{
		// The canonical text lost its trailing newline, and with it the
		// continuation that joins the last word to nothing.
		row: "trailing line continuation",
		command: "git push\\\n",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell",
		command: "(git push)",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell after a list",
		command: "(true; git push)",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell, commit",
		command: "(git commit -m x)",
		bash: "commit",
		guard: true,
	},
	{
		row: "nested subshells",
		command: "( (git push) )",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell after a cd",
		command: "(cd . && git push)",
		bash: "push",
		guard: true,
	},
	{
		row: "group",
		command: "{ git push; }",
		bash: "push",
		guard: true,
	},
	{
		row: "group around a subshell",
		command: "{ (git push); }",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell around a group",
		command: "( { git push; } )",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell, mixed executable",
		command: "(g$'i't push)",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell, escape in the executable",
		command: "($'\\x67it' push)",
		bash: "push",
		guard: true,
	},
	{
		row: "unbalanced open paren, which bash rejects",
		command: "(git push",
		bash: null,
		guard: true,
	},
	{
		row: "unbalanced close paren, which bash rejects",
		command: "git push)",
		bash: null,
		guard: true,
	},
	{
		row: "subshell around a verb the gate does not govern",
		command: "(git status)",
		bash: null,
		guard: false,
	},
	// Fail closed: a word the model cannot read.
	{
		row: "escape in the executable",
		command: "$'\\x67it' push",
		bash: "push",
		guard: true,
	},
	{
		row: "escape in the verb",
		command: "git $'\\x70ush'",
		bash: "push",
		guard: true,
	},
	{
		row: "escape in both",
		command: "$'\\x67it' $'\\x70ush'",
		bash: "push",
		guard: true,
	},
	{
		row: "escape in a shell string",
		command: "bash -c $'git\\x20push'",
		bash: "push",
		guard: true,
	},
	{
		row: "escape handed to eval",
		command: "eval $'git\\x20push'",
		bash: "push",
		guard: true,
	},
	// Round 3: a literal string handed to `eval` is a command string, as it is
	// for `bash -c`. Recurrence: review r1 F1, `eval "git push"` ran git while
	// the gate said false, because only an unquoted `eval git push` was read.
	{
		row: "eval, double-quoted string, push",
		command: 'eval "git push"',
		bash: "push",
		guard: true,
	},
	{
		row: "eval, double-quoted string, commit",
		command: 'eval "git commit -m x"',
		bash: "commit",
		guard: true,
	},
	{
		row: "eval, single-quoted string",
		command: "eval 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "eval after a double dash",
		command: 'eval -- "git push"',
		bash: "push",
		guard: true,
	},
	{
		row: "eval of a substitution that prints git push",
		command: 'eval "$(echo git push)"',
		bash: "push",
		guard: true,
	},
	{
		row: "eval, string names a verb the gate does not govern",
		command: 'eval "git status"',
		bash: null,
		guard: false,
	},
	{
		row: "eval of a plain command",
		command: "eval echo hi",
		bash: null,
		guard: false,
	},
	{
		row: "expansion as the executable",
		command: "$g push",
		bash: "push",
		guard: true,
	},
	{
		row: "expansion as the verb",
		command: "git $v",
		bash: "push",
		guard: true,
	},
	{
		row: "command substitution as the executable",
		command: "$(echo git) push",
		bash: "push",
		guard: true,
	},
	{
		row: "glob as the executable",
		command: "bin/g?t push",
		bash: "push",
		guard: true,
	},
	{
		row: "brace list as the verb",
		command: "git {push,x}",
		bash: "push",
		guard: true,
	},
	{
		row: "unknown executable before a verb word, bash runs nothing",
		command: "$unset push",
		bash: null,
		guard: true,
	},
	{
		row: "double-quoted expansion as the executable",
		command: '"$g" push',
		bash: "push",
		guard: true,
	},
	{
		row: "locale-quoted expansion as the executable",
		command: '$"$g" push',
		bash: "push",
		guard: true,
	},
	{
		row: "empty word before git",
		command: "'' git push",
		bash: null,
		guard: true,
	},
	// Unguarded: a word that is not git, or a word the model cannot read that
	// cannot be git or its verb.
	{
		row: "escaped expansion is a literal word",
		command: "\\$g push",
		bash: null,
		guard: false,
	},
	{
		row: "single-quoted expansion is a literal word",
		command: "'$g' push",
		bash: null,
		guard: false,
	},
	{
		row: "expansion after the verb word",
		command: "ls push $g",
		bash: null,
		guard: false,
	},
	{
		row: "expansion in a shell string, which names no git",
		command: 'bash -c "echo $g"',
		bash: null,
		guard: false,
	},
	{
		row: "escape in an argument of an ordinary command",
		command: "ls $'a\\tb'",
		bash: null,
		guard: false,
	},
	{
		row: "escape in a text consumer",
		command: "echo $'\\x67it' push",
		bash: null,
		guard: false,
	},
	{
		row: "expansion in a text consumer",
		command: "echo $g push",
		bash: null,
		guard: false,
	},
];

/**
 * The generated rows: every quoting of the executable and of the verbs, bare
 * and inside each subshell and group wrapper.
 */
const PLAIN: readonly string[] = [
	...spellings("git").map((spelled) => `${spelled} push`),
	...spellings("push").map((spelled) => `git ${spelled}`),
	...spellings("commit").map((spelled) => `git ${spelled} -m x`),
];
const GENERATED: readonly string[] = [
	...PLAIN,
	...COMMAND_WRAPPERS.flatMap((wrap) => PLAIN.map(wrap)),
];

/**
 * Accepted over-guards: rows bash does not run as git, which the gate guards
 * because it reads a word as git that bash reads as something else. Each is
 * base-equal (the gate guarded the row before #4739) and in the fail-closed
 * direction. Each entry carries its reason and the exact count it covers, so
 * an entry that stops matching, or starts matching more, reds here.
 */
const ACCEPTED: ReadonlyArray<{
	reason: string;
	rows: number;
	covers: (command: string) => boolean;
}> = [
	{
		reason:
			"bash reads a word holding whitespace (`git\\ push`, `'\\<newline>git'`) as one command name, and the head split reads it as `git` then `push`: a command bash cannot find",
		rows: 210,
		covers: (command) => command.includes("\\ ") || command.includes("'\\\n"),
	},
	{
		reason:
			"a backslash inside quotes (`'\\git'`, `\"\\p\"ush`) is literal to bash, and the verb normalization strips a backslash before a letter, so the gate reads the word as `git` or `push`",
		rows: 288,
		covers: (command) => /['"]\\[a-z]/.test(command),
	},
];

let root: string;
let home: string;
let log: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ggdw-"));
	home = path.join(root, "home");
	log = path.join(root, "git.log");
	fs.mkdirSync(path.join(home, "bin"), { recursive: true });
	// A recording stand-in: the real git never runs. It logs git's first
	// argument, the verb, NUL-ended (a verb word may hold a newline).
	const stub = path.join(home, "bin", "git");
	fs.writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\0\' "$1" >> "$GITLOG"\n');
	fs.chmodSync(stub, 0o755);
});

afterAll(() => {
	removeTempDirSync(root);
});

/** The governed verb real bash ran for `command`, or `null`. */
function bashRan(command: string): "commit" | "push" | null {
	fs.rmSync(log, { force: true });
	try {
		execFileSync("bash", ["-c", command], {
			cwd: home,
			env: {
				PATH: `${path.join(home, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
				HOME: home,
				LC_ALL: "C",
				GITLOG: log,
				g: "git",
				v: "push",
			},
			stdio: "ignore",
			timeout: 10_000,
		});
	} catch {
		// A command bash cannot run still logged what ran before it failed.
	}
	const verbs = fs.existsSync(log)
		? fs.readFileSync(log, "utf8").split("\0")
		: [];
	return verbs.includes("push")
		? "push"
		: verbs.includes("commit")
			? "commit"
			: null;
}

const guarded = (command: string) =>
	isGitCommitOrPushAttempt("bash", { command });

describe.skipIf(process.platform === "win32")(
	"the commit gate reads the word bash decodes (#4739)",
	() => {
		it("guards what real bash runs, row by row", () => {
			const failures: string[] = [];
			for (const row of ROWS) {
				const ran = bashRan(row.command);
				if (ran !== row.bash)
					failures.push(
						`${row.row} ${JSON.stringify(row.command)}: bash ran ${ran}, the row says ${row.bash}`,
					);
				if (guarded(row.command) !== row.guard)
					failures.push(
						`${row.row} ${JSON.stringify(row.command)}: gate ${!row.guard}, want ${row.guard}`,
					);
			}
			expect(failures).toEqual([]);
		}, 60_000);

		it("guards every generated spelling bash runs as commit or push", () => {
			const failures: string[] = [];
			const covered = ACCEPTED.map(() => 0);
			let ran = 0;
			for (const command of GENERATED) {
				const verb = bashRan(command);
				if (verb !== null) ran++;
				const gate = guarded(command);
				if (gate === (verb !== null)) continue;
				const accepted =
					gate && verb === null
						? ACCEPTED.findIndex((entry) => entry.covers(command))
						: -1;
				if (accepted >= 0) {
					covered[accepted] = (covered[accepted] ?? 0) + 1;
					continue;
				}
				failures.push(
					`${JSON.stringify(command)}: bash ran ${verb}, the gate ${gate ? "guards" : "misses"}`,
				);
			}
			// Floors: the generator still composes, and bash still ran git (a
			// missing bash would run nothing and pass every miss as accepted).
			assertNonEmptyScan("composed spellings", GENERATED.length, 2000);
			assertNonEmptyScan("spellings bash ran as commit or push", ran, 100);
			expect(failures).toEqual([]);
			expect(covered).toEqual(ACCEPTED.map((entry) => entry.rows));
			// The cost bound: one spawn per row, so the exact count bounds the run.
			expect(GENERATED.length).toBe(
				PLAIN.length * (COMMAND_WRAPPERS.length + 1),
			);
			expect(PLAIN.length).toBe(693);
		}, 120_000);
	},
);

describe("the word model the gate reads (#4739)", () => {
	const words = (command: string) =>
		decodeShellWords(command).flatMap((segment) => segment.words);

	it("reads the decoded word, not the token text", () => {
		// The legacy stream is the same `$git` for the two spellings bash
		// decodes differently; the decoded word is not.
		const legacy = (command: string) =>
			tokenizeShellCommand(command)[0]?.tokens[0];
		expect(legacy("$'git' push")).toBe(legacy("\\$'git' push"));
		expect(words("$'git' push")[0]).toEqual({ text: "git" });
		expect(words('$"git" push')[0]).toEqual({ text: "git" });
		expect(words("g$'i't push")[0]).toEqual({ text: "git" });
		expect(words("\\$'git' push")[0]).toEqual({ text: "$git" });
	});

	it("marks the words it cannot read, and which way", () => {
		expect(words("$'\\x67it'")[0]).toEqual({ text: "", hidden: "escape" });
		expect(words("g$'\\x69't")[0]).toEqual({ text: "gt", hidden: "escape" });
		for (const spelled of ["$g", "${g}", "$(echo", "`echo`", "gi?", "{git,x}"])
			expect(words(spelled)[0]?.hidden, spelled).toBe("expansion");
		for (const spelled of ["'$g'", "\\$g", "'gi?'", "$'$g'", "\\{git"])
			expect(words(spelled)[0]?.hidden, spelled).toBeUndefined();
	});

	it("ends a word at a paren, so the command word inside a subshell is its own", () => {
		// Recurrence: #4739 r2. `(git` was one word, so `(git push)` ran unguarded.
		const texts = (command: string) => words(command).map((w) => w.text);
		expect(texts("(git push)")).toEqual(["git", "push"]);
		expect(texts("( (git push) )")).toEqual(["git", "push"]);
		expect(texts("(g$'i't push)")).toEqual(["git", "push"]);
		expect(texts("{ git push; }")).toEqual(["git", "push"]);
		expect(texts("(cd x && git push)")).toEqual(["cd", "x", "git", "push"]);
		// A paren that is a character of its word stays in it: escaped, quoted,
		// or the opener of a substitution (which the gate reads as hidden).
		expect(texts("\\(git push")).toEqual(["\\(git", "push"]);
		expect(texts('"(git" push')).toEqual(["(git", "push"]);
		expect(texts("{git push")).toEqual(["{git", "push"]);
		expect(texts("$(echo git)")).toEqual(["$(echo", "git"]);
		expect(words("$(echo git)")[0]?.hidden).toBe("expansion");
	});

	it("keeps a native Windows executable path whole", () => {
		// The legacy token kept the backslashes; so does the decoded word.
		expect(words("C:\\tools\\git.exe push")[0]).toEqual({
			text: "C:\\tools\\git.exe",
		});
	});

	it("keeps `$'\\''` as one quote, so the next segment is its own", () => {
		// Recurrence: #4739. The lexer closed `$'\\'` at the escaped quote and
		// opened a quote at the real one, so `git push` sat inside it.
		expect(
			tokenizeShellCommand(": $'\\'' ; git push").map((s) => s.tokens),
		).toEqual([
			[":", "$\\'"],
			["git", "push"],
		]);
	});
});

describe("what else reads the decoded word (#4739)", () => {
	it("the shared-checkout guard sees an ANSI-C git too", () => {
		// The same matcher seam: `$'git' checkout .` rewrote the tree unguarded.
		expect(
			isWorktreeMutatingGitAttempt("bash", { command: "$'git' checkout ." }),
		).toBe(true);
	});

	it("reads the command inside a subshell or a group (r2)", () => {
		// Gains: `(git checkout .)` rewrote the tree unguarded. The commit gate
		// retires an over-guard on purpose: `{ git status; }` was an "indirect"
		// git behind a `{` word and was guarded; it is a direct git status now.
		// The shared-checkout guard answers false on it at both heads.
		const checkout = (command: string) =>
			isWorktreeMutatingGitAttempt("bash", { command });
		expect(checkout("(git checkout .)")).toBe(true);
		expect(checkout("{ git checkout .; }")).toBe(true);
		expect(checkout("(git status)")).toBe(false);
		expect(guarded("{ git status; }")).toBe(false);
		expect(guarded("(git status)")).toBe(false);
		expect(
			collectGitInvocations("bash", { command: "(git -C sub checkout .)" }),
		).toEqual([["git", "-C", "sub", "checkout", "."]]);
		// The other reader of the public token stream sees `(` and `git` apart
		// now and still names no git integration command: no gain, no loss.
		expect(isFailedGitIntegrationCommand("(git merge x)", true)).toBe(false);
	});

	it("the write scan reads a redirect inside a subshell (r2 side effect)", () => {
		// The redirect target `f.ts)` kept its paren, so the scan named no file
		// bash wrote (real bash wrote f.ts in each row but the second). Now it
		// names `f.ts`. The second row is the documented fallback: the scan keeps
		// the command's own cwd where bash wrote sub/f.ts, and recordWritten
		// confirms existence later.
		const written = (command: string) =>
			scanShellWriteScopes(command, "/w").written;
		expect(written("(printf x > f.ts)")).toEqual([path.resolve("/w", "f.ts")]);
		expect(written("echo $(printf x > f.ts)")).toEqual([
			path.resolve("/w", "f.ts"),
		]);
		expect(written("(cd sub && printf x > f.ts)")).toEqual([
			path.resolve("/w", "f.ts"),
		]);
	});

	it("reads a literal eval string for the shared-checkout guard too (r3)", () => {
		// The eval arm sits in the matcher both gates share, as the `bash -c`
		// arm does: `eval "git checkout ."` rewrote the tree unguarded, and
		// `eval "git status"` still does not match.
		const checkout = (command: string) =>
			isWorktreeMutatingGitAttempt("bash", { command });
		expect(checkout('eval "git checkout ."')).toBe(true);
		expect(checkout('eval "git status"')).toBe(false);
		expect(checkout("eval echo hi")).toBe(false);
	});

	it("targets the directory of an ANSI-C git", () => {
		expect(
			collectGitInvocations("bash", { command: "$'git' -C sub checkout ." }),
		).toEqual([["git", "-C", "sub", "checkout", "."]]);
	});

	it("fails closed only for the policy gate", () => {
		// Recurrence: #2007. The guard that protects an agent from its own
		// accident must not decline what it can read; it does not guard a word
		// it cannot read.
		expect(
			isWorktreeMutatingGitAttempt("bash", { command: "$g checkout ." }),
		).toBe(false);
		expect(
			isWorktreeMutatingGitAttempt("bash", {
				command: "$'\\x67it' checkout .",
			}),
		).toBe(false);
		expect(guarded("$g push")).toBe(true);
	});
});
