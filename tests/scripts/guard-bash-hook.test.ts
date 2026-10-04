Warning: truncated output (original token count: 29217)
Total output lines: 2972

// flake-shape: real-process-spawn — the subject IS the guard's own
// stdin/exit-code/stderr contract (what Claude Code's PreToolUse dispatch
// actually invokes); an in-process call to the exported classify functions
// cannot see a drift in that contract. Admitted in vitest.config.ts's
// wallClockBudgetInclude. The transcript harness also pins a bounded
// end-to-end budget for its 1,122 real hook processes. The scoped-pkill
// cases (#3663 CI round) also spawn real `git` to build a linked-worktree
// fixture, because F6's allow depends on a real linked worktree.
//
// #2699 (refs umbrella #2697): PreToolUse Bash guard hook.
//
// Spawns the real script as a child process with the PreToolUse JSON on
// stdin -- not just the exported classify functions -- because the
// acceptance criterion is the CLI's own stdin/exit-code/stderr contract
// (what Claude Code actually invokes), the same reasoning
// tests/scripts/classify-ci-failure-cli.test.ts documents for its own CLI:
// an in-process call to the exported functions can't notice a drift in the
// stdin shape, the exit code, or which stream carries the message.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	classifySegment,
	classifyPayload,
	findDeny,
	RULE_MESSAGES,
	scannableRegions,
	splitSegments,
	splitSegmentsWithSeparators,
	splitWords,
	stripEnvAssignments,
} from "../../scripts/hooks/guard-bash.mjs";
import type { DenyRule } from "../../scripts/hooks/guard-bash.d.mts";
import { gitExecFileSync } from "../support/git-fixture-env.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const HOOK = join(repoRoot, "scripts", "hooks", "guard-bash.mjs");

// The PreToolUse payload cwd every test in this file uses by default --
// deliberately NOT `repoRoot` (#3526 review S1). `repoRoot` is wherever
// THIS checkout happens to live, and a reviewer's own worktree convention
// puts that under `/tmp`: run there, and every relative-path exemption
// ALLOW row (".claude/worktrees/…", the "resolves under this worktree's own
// cwd" test) falsely denied, because the same /tmp root that the fix is
// SUPPOSED to catch was also, coincidentally, this suite's own cwd. A fixed,
// synthetic, guaranteed-off-/tmp path makes every relative-resolution
// assertion here true regardless of where the checkout lives -- it never
// needs to exist on disk, since none of guard-bash's path-resolution rules
// touch the filesystem at `cwd` itself (only at a RESOLVED worktree/mktemp
// argument, e.g. the node_modules-symlink-hazard fixtures below, which
// build real directories for exactly that reason).
const PAYLOAD_CWD = "/home/dev/pi-lens-guard-bash-fixed-cwd";

// Every env var this suite's own process runs under, MINUS PI_LENS_HOME --
// so a negative (deny) case can never pass because the outer test runner
// happens to have PI_LENS_HOME set (probe hygiene: this repo's own worktree
// convention sets it for ad-hoc probes), and a positive (PI_LENS_HOME
// ambient) case sets it back deliberately.
const BASE_ENV: NodeJS.ProcessEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key !== "PI_LENS_HOME"),
);

function runHook(
	command: string,
	env: NodeJS.ProcessEnv = BASE_ENV,
	cwd: string = PAYLOAD_CWD,
) {
	return spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify({
			session_id: "test",
			cwd,
			permission_mode: "default",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command },
		}),
		encoding: "utf8",
		env,
	});
}

// Every deny string the issue lists, with the rule keyword its message must
// name (the acceptance criterion: "assert exit code AND the message names
// the rule").
const DENY_CASES: Array<[command: string, ruleNeedle: string]> = [
	["git push --force origin branch", "force"],
	["git push -f origin branch", "force"],
	// review round 2 F1: an explicit lease must not mask an unconditional
	// force or a +refspec in the same push.
	["git push --force --force-with-lease=b:0123abcd origin HEAD:b", "force"],
	["git push --force-with-lease=b:0123abcd origin +HEAD:b", "force"],
	// review round 2 F4: mirror can delete and overwrite every remote ref.
	["git push --mirror origin", "force"],
	// review round 2 F5: both bundled force spellings and -C must remain
	// visible to the force-push rule.
	["git push -fu origin branch", "force"],
	["git push -uf origin branch", "force"],
	["git -C /tmp/worktree push -f origin branch", "force"],
	["git push --force-with-lease=b:012 origin HEAD:b", "force"],
	["git push --force-with-lease origin branch", "force"],
	["git push --force-with-lease=branch origin branch", "force"],
	["git push --force-w origin branch", "force"],
	["git push --force-with origin branch", "force"],
	["git push --mirr origin", "force"],
	["git push origin +HEAD:branch", "force"],
	["git rebase origin/master", "rebase"],
	// review round 2 F2: every pull/config spelling that enables rebase is
	// denied; explicit false remains an allowed opt-out.
	["git pull --rebase", "rebase"],
	["git pull -r", "rebase"],
	["git pull -vr", "rebase"],
	["git pull --rebase=true", "rebase"],
	["git -c pull.rebase=true pull", "rebase"],
	["git config pull.rebase true", "rebase"],
	["git config branch.main.rebase true", "rebase"],
	// review round 2 F3: finishing a rebase is denied, while abort/quit
	// remain available as recovery exits.
	["git rebase --continue", "rebase"],
	["git rebase --skip", "rebase"],
	["git stash", "stash"],
	["git stash list", "stash"],
	["git stash pop", "stash"],
	["git stash apply", "stash"],
	["git stash drop", "stash"],
	["git stash push", "stash"],
	["git -C /tmp/some-worktree stash", "stash"],
	// a quoted -C argument with an internal space must still fuse into ONE
	// word, or the -C pairing misaligns and "stash" is missed.
	['git -C "/tmp/some dir" stash', "stash"],
	["git reset --soft origin/master", "reset"],
	["git reset --soft origin/fix/2699-guard-bash-hook", "reset"],
	["git reset --hard HEAD", "reset"],
	["git reset --hard abc1234", "reset"],
	["git worktree remove -f -f /tmp/tree", "worktree"],
	["git worktree remove --force --force /tmp/tree", "worktree"],
	["git worktree remove -ff /tmp/tree", "worktree"],
	["node -e \"require('./clients/foo.js')\"", "probe"],
	["node --eval \"require('./clients/foo.js')\"", "probe"],
	["node --input-type=module -e \"import('./clients/foo.js')\"", "probe"],
	["node -p \"require('./clients/foo.js')\"", "probe"],
	["node clients/probe.mjs", "probe"],
	["node dist/probe.js", "probe"],
	["nodejs -e \"require('./clients/foo.js')\"", "probe"],
	// nested inside a subshell -- the tokenizer must recurse into $()/backticks.
	["echo $(git stash)", "stash"],
	["echo `git stash`", "stash"],
	// a non-PI_LENS_HOME env assignment must not defeat env-assignment
	// stripping -- the command word search must still land on "node".
	["FOO=bar node -e \"require('./clients/foo.js')\"", "probe"],
	// review round 2 F1: a real command placed AFTER a heredoc's closing
	// delimiter, on the same overall command, is still a live command.
	["cat <<EOF\nharmless text\nEOF\ngit stash", "stash"],
	// review round 2 F4: a leading "./" or an absolute path under clients/
	// must still be recognized (segment membership, not a prefix string).
	["node ./clients/probe.mjs", "probe"],
	// review round 2 F7: runner-prefix words, a path to git, a `-c` global
	// option, a single `&` separator, `{ …; }` grouping, and a backslash-
	// newline continuation must not defeat stash detection.
	["command git stash", "stash"],
	["exec git stash", "stash"],
	["env git stash", "stash"],
	["/usr/bin/git stash", "stash"],
	["./git stash", "stash"],
	["git -c user.name=agent stash", "stash"],
	["cd /tmp & git stash", "stash"],
	["{ git stash; }", "stash"],
	["git \\\nstash", "stash"],
	// review round 3 V5: `sudo` and `time` are runner prefixes -- both
	// confirmed against real bash to run their argument.
	["sudo git stash", "stash"],
	["time git stash", "stash"],
	// review round 3 V3b: a CRLF command text. Before this round the
	// delimiter line "EOF\r" never matched "EOF", so the body ran to
	// end-of-text and silently swallowed the real command after it.
	["cat <<'EOF'\r\nbody\r\nEOF\r\ngit stash", "stash"],
	// review round 3: bash drops a backslash before an ordinary character,
	// so this really does run git stash.
	["\\g\\i\\t stash", "stash"],
	// review round 3: `( … )` command grouping (round 2 documented this as
	// unhandled; segment splitting on the metacharacters makes it free).
	["(cd /tmp && git stash)", "stash"],
	// review round 3 V3a (LX-5-4), through the real CLI: an UNQUOTED
	// heredoc delimiter does not stop bash expanding $( ) in the body --
	// verified by running it with a side-effecting stand-in.
	["cat <<EOF\n$(git stash)\nEOF", "stash"],
	// review round 2 F1: a valid substitution before an unclosed one must
	// remain visible to the guard, because bash expands it before reporting
	// the later malformed substitution.
	["cat <<EOF\n$(git stash)\n$(echo harmless\nEOF\ngit diff", "stash"],
	// verify round 2: the backtick flush is a separate branch in the hook, so
	// it needs its own case -- deleting only that branch left the `$( )` case
	// green while this one allowed.
	["cat <<EOF\n`git stash`\n`echo harmless\nEOF\ngit diff", "stash"],
	// W1 (#2726): a here-string is not a heredoc marker.  The command after
	// it remains live and must still be classified.
	["grep x <<< foo\ngit stash", "stash"],
	// #3026 (2026-09-15), the recurrence this rule prevents: a fixer aimed
	// TMPDIR at the vitest harness's own PI_LENS_HOME, then reported "16
	// suites red on origin/master" from a tree that was green. The command
	// is VERBATIM from that PR body. Measured on this branch:
	// tests/clients/ext-gate-before-ignore.test.ts is 8/8 green with TMPDIR
	// elsewhere and 7 failed / 1 passed with this prefix.
	[
		"TMPDIR=$PWD/.probe-home npx vitest run tests/clients/ext-gate-before-ignore.test.ts",
		"tmpdir",
	],
	// The export spelling of the same offence -- a separate branch of
	// classifySegment (the export builtin never runs a trailing command, so
	// it returns before the command dispatch).
	["export TMPDIR=$PWD/.probe-home && npm test", "tmpdir"],
	// A quoted value, and an absolute path: segment membership, not a
	// $PWD-prefix string match, is what decides.
	['TMPDIR="/home/dev/wt/.probe-home" npm test', "tmpdir"],
	// A directory UNDER the harness home is the same collision.
	["TMPDIR=$PWD/.probe-home/tmp npm test", "tmpdir"],
	// TMP and TEMP reach os.tmpdir() too (measured; see TEMP_DIR_VARS).
	["TMP=$PWD/.probe-home npm test", "tmpdir"],
	["TEMP=$PWD/.probe-home npm test", "tmpdir"],
	// The variable spelling of the same directory -- what an agent reaches
	// for straight after reading the `probe` rule's own message.
	["TMPDIR=$PI_LENS_HOME npx vitest run tests/config", "tmpdir"],
	["TMPDIR=${PI_LENS_HOME}/x npx vitest run tests/config", "tmpdir"],
	["TMPDIR=$PI_LENS_HOME/sub npx vitest run tests/config", "tmpdir"],
	// #3556: pkill/killall with a bare, unscoped pattern -- the acceptance
	// criterion's own reproduction ("The hook refuses `pkill -f tlc2.TLC`").
	["pkill -f tlc2.TLC", "pkill"],
	["pkill tlc2", "pkill"],
	["killall tlc2.TLC", "pkill"],
	["killall -9 vitest", "pkill"],
	// #3526: an absolute /tmp destination for a scratch checkout -- the
	// incident this rule fixes, verbatim.
	["git worktree add /tmp/pi-lens-review-1234", "/tmp"],
	[
		"git clone https://github.com/apmantza/pi-lens /tmp/pi-lens-scratch",
		"/tmp",
	],
	// An absolute mktemp template, or an explicit -p/--tmpdir=, under /tmp --
	// self-contained (unlike the bare "mktemp -d" default, this does not
	// depend on this test runner's own ambient TMPDIR).
	["mktemp -d /tmp/pi-lens-review-XXXXXX", "/tmp"],
	["mktemp -d -p /tmp/scratch foo.XXXXXX", "/tmp"],
	["mktemp --directory --tmpdir=/tmp/scratch foo.XXXXXX", "/tmp"],
	// #3471: a check's exit code lost to `;`/`|` before an unconditional
	// git commit/push -- the issue's own case 1 and case 2, verbatim.
	[
		'npm run lint >/dev/null 2>&1; echo "lint=$?"; git add -A && git commit -m "x"',
		"chained",
	],
	[
		"npx vitest run tests/foo.test.ts 2>&1 | grep -iE 'error|fail'; git add -A && git commit -m x && git push origin y",
		"chained",
	],
	// #3883: a pipeline reads the pipe's status, not ci-verdict's status;
	// the final `ci-verdict: exit` line is the authoritative status instead.
	["node scripts/ci-verdict.mjs 1 | tail; echo $?", "ci-verdict"],
	// #3883 F6: wrappers and spellings the round-1 rule missed.
	["timeout 600 node scripts/ci-verdict.mjs 1 | tail; echo $?", "ci-verdict"],
	[
		"timeout --foreground 600 node scripts/ci-verdict.mjs 1 | tail; echo $?",
		"ci-verdict",
	],
	["node --no-warnings scripts/ci-verdict.mjs 1 | tail; echo $?", "ci-verdict"],
	["node scripts/ci-verdict.mjs 1 | tail; echo ${?}", "ci-verdict"],
	["node scripts/ci-verdict.mjs 1 |& tail; echo $?", "ci-verdict"],
	// #3883 R2: `timeout`'s own options take arguments (`-s KILL`, `-k 5`), so
	// the duration read must not land on the signal.
	[
		"timeout -s KILL 600 node scripts/ci-verdict.mjs 1 | tail; echo $?",
		"ci-verdict",
	],
	[
		"timeout -k 5 600 node scripts/ci-verdict.mjs 1 | tail; echo $?",
		"ci-verdict",
	],
	// #3883 R2: the single-quote stripper must not treat an apostrophe inside a
	// double-quoted string as opening a single-quote span that hides `$?`.
	[
		"node scripts/ci-verdict.mjs 1 | tail; echo \"it's $? ok it's\"",
		"ci-verdict",
	],
	// #3883 R2: `set +o pipefail` DISABLES pipefail, so the pipeline's `$?` is
	// the filter's status again.
	[
		"set +o pipefail; node scripts/ci-verdict.mjs 1 | tail; echo $?",
		"ci-verdict",
	],
];

// Every allow string the issue lists, which must stay green.
const ALLOW_CASES: string[] = [
	"git push",
	"git push origin HEAD:branch",
	"git push --force-with-lease=branch:0123456789abcdef0123456789abcdef01234567 origin HEAD:branch",
	"git rebase --abort",
	"git rebase --quit",
	"git pull --rebase=false",
	"git pull --rebase=no",
	"git pull --rebase=0",
	"git pull --rebase=off",
	"git -c pull.rebase=false pull",
	"git -c pull.rebase=no pull",
	"git -c pull.rebase=0 pull",
	"git -c pull.rebase=off pull",
	"git config pull.rebase false",
	"git config pull.rebase no",
	"git config pull.rebase 0",
	"git config pull.rebase off",
	"git config branch.main.rebase false",
	"git diff > fix.patch",
	"git checkout HEAD -- x",
	"git worktree remove -f /tmp/tree",
	"git worktree remove --force /tmp/tree",
	"git reset HEAD~1",
	"git log --grep=stash",
	'echo "git stash"',
	"PI_LENS_HOME=/x node -e \"require('./clients/foo.js')\"",
	"node scripts/ci-verdict.mjs 1",
	// #3883: piping output without reading `$?` is a valid way to inspect the
	// command's output; only `| tail` shows the final `ci-verdict: exit`
	// line, and this `| head` form reads no status either way.
	"node scripts/ci-verdict.mjs 1 | head",
	// #3883: capture `$?` before sending the captured status through a pipe.
	"node scripts/ci-verdict.mjs 1; echo $? | tail",
	// #3883 F5: a `;`-separated segment between ci-verdict and the `$?` read is
	// not a pipe, so the status is still ci-verdict's own.
	"node scripts/ci-verdict.mjs 1; git status; echo $?",
	// #3883 F6: `set -o pipefail` makes the pipeline's status the real one.
	"set -o pipefail; node scripts/ci-verdict.mjs 1 | tail; echo $?",
	// #3883 R2: a later `set +o pipefail` disables it, and re-enabling after a
	// disable still makes the pipeline's status the real one.
	"set +o pipefail; set -o pipefail; node scripts/ci-verdict.mjs 1 | tail; echo $?",
	// #3883 F6: a single-quoted `'$?'` is literal text, not the status.
	"node scripts/ci-verdict.mjs 1 | tail; echo '$?'",
	// #3723: the sanctioned form of the worktree open/close sequence the
	// hook's worktreeSymlink rule otherwise denies -- a node script, not a
	// hand-typed `git worktree remove`, and it loads no clients/ or dist/ code.
	"node scripts/pr-worktree.mjs open 9001 --head --name review-1",
	"node scripts/pr-worktree.mjs open 9001 --merge",
	"node scripts/pr-worktree.mjs close /home/dev/Desktop/pi-lens-worktrees/review-1",
	"npx vitest run tests/clients/foo.test.ts",
	"npm test",
	"npm run build",
	"echo hi",
	// node with neither an eval flag nor a .mjs/.js file argument, even
	// though the text mentions clients/ -- the flag/file-arg gate, not the
	// clients/dist reference alone, must decide.
	"node -c clients/tsconfig.json",
	// node -e with no clients/ or dist/ reference at all -- the reference
	// gate, not the eval flag alone, must decide.
	'node -e "console.log(1)"',
	// --soft with no origin/ target -- only "--soft origin/<branch>" denies.
	"git reset --soft HEAD~1",
	// worktree subcommand other than "remove" -- the remove check, not a
	// bare "worktree" match, must decide.
	"git worktree list",
	// double-force on a non-"remove" worktree subcommand -- the rule is
	// "remove with two forces", not "worktree with two forces anywhere".
	// (#3526: the path is off /tmp on purpose -- a /tmp destination is its
	// own, unrelated deny, tmpCheckout, pinned separately below.)
	"git worktree add .claude/worktrees/new-tree -f -f",
	// $(...) fully inside single quotes is literal text to bash (no
	// expansion), so the tokenizer must not extract it as a subshell.
	"echo '$(git stash)'",
	// review round 2 F1: the reviewer's own reproduction set -- a heredoc
	// body mentioning a forbidden command (as literal text, or inside a
	// markdown inline-code span) is not a live command, in each of these
	// shapes: a $()-wrapped `cat` heredoc feeding a CLI flag, a bare `cat`
	// redirect, a `git commit -F` heredoc, and a heredoc through a
	// different interpreter (python) whose own quoting happens to also
	// protect it.
	"gh pr create --body \"$(cat <<'EOF'\nSome text mentions `git stash` inline but is not a command.\nEOF\n)\"",
	"cat > CLAUDE.md <<'EOF'\n- `git stash` is forbidden.\nEOF",
	"gh issue comment 2699 --body \"$(cat <<'EOF'\nDo not run `git reset --hard HEAD`.\nEOF\n)\"",
	"git commit -F - <<'EOF'\nfix: mentions `git stash` in the body\nEOF",
	"python3 <<'PYEOF'\nprint(\"do not run git reset --soft origin/master\")\nPYEOF",
	// review round 2 F2: AGENTS.md sanctions `export PI_LENS_HOME=<dir>` as
	// an earlier `;`/newline-separated segment, not only this segment's own
	// prefix or process.env.
	"export PI_LENS_HOME=/x/.probe-home; node -e \"require('./clients/foo.js')\"",
	"export PI_LENS_HOME=/x/.probe-home\nnode -e \"require('./clients/foo.js')\"",
	// review round 2 F4: a leading "./" before scripts/, and an absolute
	// path under scripts/, must still be recognized as exempt.
	"node ./scripts/ci-verdict.mjs 1",
	"node /home/dev/pi-lens/scripts/ci-verdict.mjs 1",
	// review round 2 F5: a payload that MENTIONS "clients/" without
	// actually loading it (the orchestrator's doc-patching idiom) must
	// allow -- only an actual require(/import(/from load specifier denies.
	"node -e \"console.log('note: see clients/ for the service list')\"",
	// review round 3 V1 (LX-6-2), through the real CLI: the exact minimal
	// reproduction the round 2 verify filed -- one unbalanced ")" in a
	// quoted heredoc body used to close the enclosing $( ) span early and
	// leak the rest of the document into the top-level scan.
	"gh pr create --body \"$(cat <<'EOF'\nsmiley :) here\nwe never run `git stash`\nEOF\n)\"",
	// review round 3 (LX-10-1), through the real CLI: a `#` comment.
	"echo hi # $(git stash)",
	// W2 (#2726): real bash does not execute an unclosed substitution in an
	// unquoted heredoc body, but it does continue with a later live command.
	"cat <<EOF\n$(git stash\nEOF\ngit diff",
	"cat <<EOF\n`git stash\nEOF\ngit diff",
	// Real bash reports the malformed outer substitution and does not run a
	// nested substitution inside it.
	"cat <<EOF\n$(echo x\n$(git stash)\nEOF",
	// #3026: the COMPLIANT shapes of the tmpdirCollision rule. TMPDIR aimed
	// at its own directory, with PI_LENS_HOME still pinned at .probe-home
	// exactly as AGENTS.md "Probe hygiene" prescribes.
	"PI_LENS_HOME=$PWD/.probe-home TMPDIR=$PWD/.tmp-disk npx vitest run tests/config",
	"export TMPDIR=/home/dev/.cache/lane-tmp\nnpx vitest run tests/config",
	// TMPDIR untouched -- the harness keeps the real one on purpose.
	"PI_LENS_HOME=$PWD/.probe-home npx vitest run tests/config",
	// A neighbouring directory whose NAME merely starts with the harness
	// segment is a different directory (segment equality, not prefix).
	"TMPDIR=$PWD/.probe-home-2 npm test",
	// PI_LENS_HOME itself pointed at .probe-home is the PRESCRIBED form and
	// must never be caught by the TMPDIR rule.
	"PI_LENS_HOME=$PWD/.probe-home npm test",
	"export PI_LENS_HOME=$PWD/.probe-home && npm test",
	// Review round 2 T3: a DIFFERENT variable whose name merely starts with
	// PI_LENS_HOME names a different directory. Both were denied before the
	// name boundary landed.
	"TMPDIR=$PI_LENS_HOME_TMP npm test",
	"TMPDIR=$PI_LENS_HOMEDIR/x npm test",
	// Review round 2, named limit: a third variable hides the path from a
	// static scan, so this ALLOWS. The row exists so the limit is a pinned,
	// visible behaviour rather than an untested claim in a docblock.
	"export PROBE_HOME=$PWD/.probe-home; export TMPDIR=$PROBE_HOME; npm test",
	// #3556: `kill <pid>` is a different command from pkill/killall entirely
	// -- the acceptance criterion's own "It allows `kill <pid>`".
	"kill 12345",
	"kill -9 12345",
	// #3526: the acceptance list's own named exemptions. `.claude/worktrees/`
	// is relative, resolved against `PAYLOAD_CWD` (this suite's own default
	// cwd), which is never under /tmp.
	"git worktree add .claude/worktrees/agent-3526-deadbeef",
	"git worktree add ~/.cache/pi-lens-orchestrator/worktrees/agent-x",
	"git worktree add ~/.local/share/pi-lens-orchestrator/tmp/lane-1",
	"git worktree add ~/.plegma/work/sub-1",
	// git clone with no explicit destination -- name-derived, out of scope
	// (documented blind spot: this static scan cannot resolve it).
	"git clone https://github.com/apmantza/pi-lens",
	// git clone WITH an explicit destination, off /tmp.
	"git clone https://github.com/apmantza/pi-lens /home/dev/scratch/pi-lens",
	// mktemp for a FILE (no -d/--directory) is always allowed regardless of
	// where it lands -- even a FILE path that is itself under /tmp.
	"mktemp foo.XXXXXX",
	"mktemp /tmp/pi-lens-review-file.XXXXXX",
	"mktemp",
	// An explicit -p/--tmpdir= OUTSIDE /tmp allows even though the template
	// itself is bare.
	"mktemp -d -p /home/dev/scratch foo.XXXXXX",
	"mktemp -d --tmpdir=/home/dev/scratch foo.XXXXXX",
	// rm/ls/du/find on /tmp are untouched -- this file never classifies them.
	"rm -rf /tmp/pi-lens-review-1234",
	"ls /tmp",
	// #3471: fully `&&`-gated -- the issue's own case 1 and case 2, rewritten.
	'npm run lint >/dev/null 2>&1 && git add -A && git commit -m "x"',
	"npx vitest run tests/foo.test.ts && git add -A && git commit -m x && git push origin y",
	// An ordinary sequential status check after a commit -- no check precedes
	// the commit at all, so nothing is judged. A general "a write must be
	// &&-only or command-final" rule would deny this harmless pattern; see
	// the PR body for why that shape was rejected.
	'git commit -m "x" ; git status',
	// A write gated by an EARLIER write via && -- the boundary-stop search
	// for the nearest check must not reach back past it.
	"npm run lint && git push origin y ; git commit -m x",
	// Gated through shell control flow (`if [ $vexit -eq 0 ]`, this repo's
	// own convention for deciding after saving a check's exit code) rather
	// than `&&` -- unmodeled, so left alone rather than guessed at.
	"npm run build; vexit=$?; if [ $vexit -eq 0 ]; then git commit -m x; fi",
	// A node script that is NOT scripts/check-*.mjs is not a "check".
	"node scripts/build.mjs ; git commit -m x",
	// Two checks, `;`-separated, with NO git commit/push anywhere -- nothing
	// for this rule to judge at all.
	"npm run lint ; npm run build",
];

// Round-2 survey harness retained as a regression fixture for #2705. The
// synthetic 2026-09-07 corpus is above; the real transcript corpus below is
// `tests/fixtures/guard-bash/transcript-corpus-2026-09-08.json`, extracted
// from this project's Claude Code session transcripts on 2026-09-06..08 with
// secrets and the maintainer's email scrubbed. The fixture is data under
// tests/fixtures, so test-file sweeps do not walk it as executable code.
const SURVEY_CORPUS_DATE = "2026-09-07";
const SURVEY_CORPUS = [
	...DENY_CASES.map(([command]) => ({ command, expected: "deny" as const })),
	...ALLOW_CASES.map((command) => ({ command, expected: "allow" as const })),
];

const TRANSCRIPT_CORPUS = JSON.parse(
	readFileSync(
		join(
			repoRoot,
			"tests/fixtures/guard-bash/transcript-corpus-2026-09-08.json",
		),
		"utf8",
	),
) as Array<{ command: string; firstSeen: string }>;

const TRANSCRIPT_CORPUS_DATE = "2026-09-07..08";

function commandHash(command: string): string {
	return createHash("sha256").update(command).digest("hex");
}

// These are the only two commands in the 2026-09-07..08 transcript corpus
// that exercise a guard rule. Keep this allowlist independent of findDeny so
// a rule widening cannot silently turn a false positive into an expectation.
//
// #3471's `checkUngated` rule audited the same corpus and found 20 REAL
// historical instances of the exact shape the issue describes: a check
// (`npm run lint`/`build`/`test`, `npx vitest`, `node scripts/check-*.mjs`)
// piped to `grep`/`tail`/`head` -- which replaces its exit status with the
// filter's, almost always 0 -- and/or separated by `;`, with a `git
// commit`/`git push` then running unconditionally (or gated on the WRONG,
// filter's, exit status) rather than on the check's own result. Each one
// was read in full before pinning (the PR body quotes one representative
// example, `ff582cb3…`, in full; the rest are read and reasoned about
// individually, not re-quoted). None is gated through shell control flow
// (that shape -- `vexit=$?; …; if [ $vexit -eq 0 ]; then git commit …; fi`,
// also present in this corpus -- is excluded per-WRITE, not per-region, see
// `writeIsInsideControlFlow` in guard-bash.mjs, and contributes ZERO of
// these 20 checkUngated pins).
//
// #3526 review round 2 (F1, F3, F4) re-audited after three fixes and found
// 17 more real instances, also read in full before pinning:
//   - F1 (variable-indirected /tmp destinations, `S=/tmp/…; W=$S/wt; git
//     worktree add $W` -- the ACTUAL shape of every historical /tmp
//     worktree-add in this corpus, never a literal `$TMPDIR`): 9 new
//     `tmpCheckout` denies.
//   - F3 (the control-flow exemption moved from whole-region to per-write):
//     1 new `checkUngated` deny (`e3cbc7a3…`) -- an EARLIER, already-closed
//     `for…do…done` loop no longer exempts a LATER, genuinely ungated
//     check -> write in the same region.
//   - F4 (`vitest` recognized by basename, a bare `timeout <duration>`
//     prefix stepped past, `npm test`/`npm t` added): 7 new `checkUngated`
//     denies -- this repo's own `timeout N node_modules/.bin/vitest`/
//     `timeout N npx vitest` convention, previously invisible to the check
//     set entirely (the `timeout` word was an unrecognized command, not
//     stripped).
const EXPECTED_TRANSCRIPT_DENIES = new Set([
	// #3888 audit: no executable historical `git push --force`, `+refspec`,
	// or `git rebase` rows were present; prose and commit-message mentions are
	// inert and remain correctly allowed by the corpus test.
	"21def4efd19e12fd4fcb3f0cfcbc7f000814ed54d6ecdb39701e74b08288811f",
	"22441661595314c7a8207f7cb04bee63c81882c05e64e5325d7245ffcb3ec5d7",
	// #3471 checkUngated -- audited true positives, round 1 (20):
	"ff582cb347e379fcf2dd2e965ea22a0313e76f18edad51ef7efc0cd01ad7b0ae",
	"ada188d5f502c2c534e449a06b19aeef59e5d3f48e47f7061a1b8e65d1c55bce",
	"a4f133cc3630108fcac7048f875b54e8920a2e01ba1f05426fbea6d4155d5582",
	"361b6ddfa5b81d111cd47883870ab7fcbd46a338ebe34e0f195dad22fdacd1cd",
	"b7e841213ab73312e829093f80495d3e5137b12f9119527b7a72828756a3953c",
	"07db63515b544bb9590a9cc2b2635ab663bbebd9dbc3e678e8a045027108a86d",
	"753dcb972e90d8bf7eea472aaef27385c204a8207161c1ca4108fd1d6a2ceb86",
	"6cfb7e92ef0c2eca551db9a684e8f172cc518b918a9905893e708fe147d1b160",
	"be38e0c9692695e1a954326eec1d4b58ab1f16f109541388a8ff2b021a1d899c",
	"1fe3f8f5d4256ba9cf4533648d9042f8b3241a32e7d9cb4e68a418b1f772c7c3",
	"9149ffc1d0e49e2f5f95034626f1af7d29cc392acd80c0a3d9a9a8444186c296",
	"51da626c87c6754f450617d738c4bdc7367a700a4fcaa9cc7833ff4ce8bd2aa5",
	"a7e72ce55e6a139fbfb8cf1ccef5c44195354c4b6f7148c0c2da23c94722ece6",
	"a2643e0ca815efd1cc39f61df81a82b09369581c96fef17f50ef2c8368daa6a6",
	"6df74407743e7df399c37e01281948bb3a10120a3ecf3d705d1208853a35bd61",
	"058bbb4cf2d5477a7451cf3b0e81452096e6935e66696fe67f3ce68ee2c46904",
	"a50b6f92c8f233d7b0794c66a968106330905c6d23fdcd64ca561570758ed769",
	"247e48689008fc34af723b56eb1e1faea15683d8b77bdaddb8ed0967b3070ed8",
	"a5aaebed4a33c5a63036aa4de421060ee3742097384404930ac7382dae1ef25a",
	"b536e5e79822d8de332813a67673887436042c628b4751f25e8500fd0411cbff",
	// #3526 review round 2, F1 -- variable-indirected /tmp worktree-adds (9):
	"4162c428ba3cd3eb276a0980fd1a8d7444e6f55ef356a7c5ab5d4143e92aff49",
	"06609131379d5d1b21c2f1a68b2346d4c9c63741a73d08c06ecf72f8e15aa423",
	"e13eea5655fe6e57395def929222751b50359d41dffbee72d2b6e9c1d7150ae7",
	"94a337509cf95b0daa738e00d023e78e2e9a4cd4e3e08c260ad07ac4c53bb112",
	"8166b556313c947b48016bfc552c5a5cec196bd5bb5ce2f0f8890ed246307809",
	"afdf482fd5cae451a226ebf0ebe721e433442fc86a5772b3bba56e823474e4fc",
	"78b2ecd67afae2eabc3b4db24f3e8bb154f9d0ff23c2d598117834bfce33bcad",
	"e0dd951d15e8ef944ae1a8b22ff6355567dd546c70a65e8e73d313dda91fffce",
	"f5c05f910019f743bb94c7d086b5cc3e82371321624400e19831e2e7b6bafe42",
	// #3526 review round 2, F3 -- an earlier CLOSED for/do/done loop no
	// longer exempts a later genuinely ungated check -> write (1):
	"e3cbc7a31b6837426817b794e54db318d3fef8fb766c023014336d7c1baae8e5",
	// #3526 review round 2, F4 -- timeout-wrapped / basename-resolved
	// vitest, previously invisible to the check set entirely (7):
	"99384a2525ff8dddfee78c82c51af7021f01d6165005167033a717ffc56ea077",
	"a6e2260e0c64ac20af126d1d7990830de94cce598da9bde0610262e75e3c905d",
	"e849647d34e37aab0f927095172358192015259992a7202e98c09ee960b26a31",
	"830516326aef8a7961d80c8b2ebcf53243a6c3408a2120f4bb6dcfc3386b3650",
	"f8e25082d8aab77f62006719b1a214b65cb87af7faeb8d5baf12574d9480c366",
	"cad4314ec40a34fb85ae43f865f96b5862397f363e26003cc814e87dfafceebf",
	// #3883 (round 2): six real historical `ci-verdict … | tail; echo "exit=$?"`
	// reads the new rule flags. Each was read in full; the `$?` is the tail's
	// status, not ci-verdict's verdict, and none enables `pipefail` first.
	"71eeb73974cf43c002ee51e46d0ad68a98243e20ded231956f12bf8948c547ab",
	"c9d112f10e0bc11cad5f0fdf866da6237cb90a92d0c8dbf70fcf189cbfb6e870",
	"e2cc62fdb1cd8355b95d36151544d43a77e35678b98007dddd206c77fe5cedf2",
	"a22ad5af048cb1448818b448f7c18287dbfeea08df29e05b0bf05e254ca0eaba",
	"94854ee02d361bd93e7e8b4020fb49cb30573937b576e435abffb6a1734827dd",
	"6ffdccbc34f482d728a5d85c70a93409ce0fd45ebf315a0fb8c931ef2aa4d4d5",
]);

const EXPECTED_TRANSCRIPT_ALLOWS = new Set([
	// Historical plegma maintenance transcript is an explicit allow.
	"30b1b57e56ca162793f411ef91bc8e47607a91f420039b3e00451ecd5278ea02",
]);

describe("scripts/hooks/guard-bash.mjs -- deny list (#2699)", () => {
	it.each(DENY_CASES)("denies %j", (command, ruleNeedle) => {
		const result =…13217 tokens truncated…t cwd is itself under /tmp", () => {
		// #3526's acceptance: "a git worktree add ../x from a checkout under
		// /tmp is denied" -- built with a real cwd under /tmp so the
		// resolution is not a fictitious path string.
		const underTmp = "/tmp/pi-lens-guard-bash-3526-cwd-fixture";
		expect(findDeny("git worktree add ../sibling-tree", underTmp)).toBe(
			"tmpCheckout",
		);
	});

	it("a literal $TMPDIR-shaped worktree destination defaults to /tmp when TMPDIR is not set on this command or ambiently", () => {
		const result = runHook(
			'git worktree add "$TMPDIR/foo"',
			NO_AMBIENT_TMPDIR_ENV,
		);
		expect(result.status).toBe(2);
	});

	it("the SAME $TMPDIR-shaped destination allows once this command's own TMPDIR= points off /tmp", () => {
		expect(
			findDeny(
				'TMPDIR=/home/dev/scratch git worktree add "$TMPDIR/foo"',
				PAYLOAD_CWD,
			),
		).toBeNull();
	});

	it("a /tmp string inside a comment, a heredoc body, or echo text never trips the rule -- this rule reads argv WORDS, not raw text", () => {
		expect(
			findDeny(
				"echo 'scratch checkouts must never land under /tmp' # reminder",
			),
		).toBeNull();
		expect(
			findDeny("cat <<'EOF'\nmktemp -d /tmp/not-a-real-command\nEOF"),
		).toBeNull();
	});

	// #3526 review F1: the historical incident shape, verbatim. All 14 real
	// `/tmp` worktree-adds in the transcript corpus use variable indirection
	// (`S=/tmp/…; W=$S/wt; git worktree add $W`), never a literal `$TMPDIR`.
	describe("variable-indirected destinations (review F1)", () => {
		it("resolves a one-hop indirected /tmp destination", () => {
			expect(
				findDeny(
					"S=/tmp/claude-0/x/scratchpad; W=$S/wt; git worktree add -q --detach $W HEAD",
					PAYLOAD_CWD,
				),
			).toBe("tmpCheckout");
		});

		it("resolves a two-hop indirected /tmp destination", () => {
			expect(
				findDeny("A=/tmp/x; B=$A/y; git worktree add $B", PAYLOAD_CWD),
			).toBe("tmpCheckout");
		});

		it("keeps an indirected NON-/tmp destination allowed", () => {
			expect(
				findDeny('W=".claude/worktrees/a"; git worktree add "$W"', PAYLOAD_CWD),
			).toBeNull();
			expect(
				findDeny(
					"S=~/.local/share/pi-lens-orchestrator/tmp; W=$S/wt; git worktree add $W",
					PAYLOAD_CWD,
				),
			).toBeNull();
		});

		it("does not hang on a self-referential chain, and stays allowed (the cap breaks the loop, leaving unresolved $A as literal text)", () => {
			expect(findDeny("A=$A; git worktree add $A", PAYLOAD_CWD)).toBeNull();
		});

		it("resolves a chain up to the cap depth", () => {
			expect(
				findDeny(
					"A=/home/x; B=$A/y; C=$B/z; D=$C/w; git worktree add $D",
					PAYLOAD_CWD,
				),
			).toBeNull();
		});

		it("mktemp -p also resolves through indirection", () => {
			expect(
				findDeny("S=/tmp/scratch; mktemp -d -p $S foo.XXXXXX", PAYLOAD_CWD),
			).toBe("tmpCheckout");
		});
	});

	// #3526 review F2: bundled short mktemp flags and -t, measured against
	// real GNU coreutils 9.4 (PR body has the transcript).
	describe("bundled short mktemp flags and -t (review F2)", () => {
		it("denies -d -t, -dt, -dp DIR, and -qd /tmp/X", () => {
			// #3556 S4: make the intended /tmp landing explicit. The classifier
			// correctly reads the real process environment for `-t`, so an
			// orchestrator lane's off-/tmp TMPDIR must not change this fixture.
			expect(
				findDeny("TMPDIR=/tmp mktemp -d -t rvprobe.XXXX", PAYLOAD_CWD),
			).toBe("tmpCheckout");
			expect(findDeny("TMPDIR=/tmp mktemp -dt rvprobe.XXXX", PAYLOAD_CWD)).toBe(
				"tmpCheckout",
			);
			expect(findDeny("mktemp -dp /tmp rvprobe.XXXX", PAYLOAD_CWD)).toBe(
				"tmpCheckout",
			);
			expect(findDeny("mktemp -qd /tmp/pi-lens-review-XXXX", PAYLOAD_CWD)).toBe(
				"tmpCheckout",
			);
		});

		it("allows the same bundled forms when -p/-t root off /tmp", () => {
			expect(
				findDeny("mktemp -dp /home/dev/scratch rvprobe.XXXX", PAYLOAD_CWD),
			).toBeNull();
			expect(
				findDeny(
					"TMPDIR=/home/dev/scratch mktemp -dt rvprobe.XXXX",
					PAYLOAD_CWD,
				),
			).toBeNull();
		});

		it("a bundled flag with no 'd' letter stays file mode (always allowed)", () => {
			expect(findDeny("mktemp -qt rvprobe.XXXX", PAYLOAD_CWD)).toBeNull();
		});
	});

	// #3526 review S1: bash resolves `~` before the program ever sees argv;
	// this static scanner has to redo that step, and must do it regardless
	// of where the payload cwd happens to be (a reviewer's own worktree may
	// itself sit under /tmp).
	describe("~ (HOME) expansion (review S1)", () => {
		it("expands ~/… to a real HOME even when cwd is itself under /tmp", () => {
			const underTmpCwd = "/tmp/some-review-worktree";
			expect(
				findDeny(
					"git worktree add ~/.cache/pi-lens-orchestrator/worktrees/agent-x",
					underTmpCwd,
				),
			).toBeNull();
			expect(
				findDeny(
					"git worktree add ~/.local/share/pi-lens-orchestrator/tmp/lane-1",
					underTmpCwd,
				),
			).toBeNull();
			expect(
				findDeny("git worktree add ~/.plegma/work/sub-1", underTmpCwd),
			).toBeNull();
		});

		it("expands ~ picked up MID-CHAIN through variable indirection", () => {
			expect(
				findDeny(
					"S=~/.local/share/pi-lens-orchestrator/tmp; W=$S/wt; git worktree add $W",
					"/tmp/some-review-worktree",
				),
			).toBeNull();
		});

		it("bare ~ alone expands too, even when cwd is itself under /tmp", () => {
			// A cwd OFF /tmp would allow this even if `~` were left unexpanded
			// (the unresolved literal is still a relative path that resolves
			// off-tmp against an off-tmp cwd) -- this must use an UNDER-/tmp
			// cwd, the same way the `~/…` cases above do, so the assertion
			// actually depends on the bare-`~` branch running.
			expect(
				findDeny("git worktree add ~", "/tmp/some-review-worktree"),
			).toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------
// #3471: git commit/push chained after an ungated check (checkUngated)
// ---------------------------------------------------------------------------
//
// #3471: a check (npm run lint/build/test/fmt:check/preflight, npx vitest,
// tsc, node scripts/check-*.mjs) piped or `;`-separated from a following git
// commit/push never gates it -- three 2026-09-25 incidents, quoted in the
// PR body verbatim as DENY_CASES entries above; the corpus audit below (also
// in the PR body) found the SAME shape 20 more times in real history.
describe("scripts/hooks/guard-bash.mjs -- git commit/push chained after an ungated check (#3471)", () => {
	it("tsc as a check", () => {
		expect(findDeny("tsc --noEmit ; git commit -m x")).toBe("checkUngated");
		expect(findDeny("tsc --noEmit && git commit -m x")).toBeNull();
	});

	it("node scripts/check-*.mjs as a check", () => {
		expect(
			findDeny("node scripts/check-pr-body.mjs 123 ; git push origin y"),
		).toBe("checkUngated");
		expect(
			findDeny("node scripts/check-pr-body.mjs 123 && git push origin y"),
		).toBeNull();
	});

	it("a DIFFERENT node script is not a check", () => {
		expect(findDeny("node scripts/build.mjs ; git commit -m x")).toBeNull();
	});

	// #3471 review F4: `npx vitest` alone missed this repo's own convention.
	describe("vitest by basename, a timeout prefix, and npm test (review F4)", () => {
		it("node_modules/.bin/vitest is a check, resolved by basename", () => {
			expect(
				findDeny(
					"node_modules/.bin/vitest run t.test.ts 2>&1 | grep x; git commit -m x",
				),
			).toBe("checkUngated");
			expect(
				findDeny("node_modules/.bin/vitest run t.test.ts && git commit -m x"),
			).toBeNull();
		});

		it("a bare timeout <duration> prefix is stepped past", () => {
			expect(
				findDeny(
					"timeout 400 node_modules/.bin/vitest run t.test.ts 2>&1 | grep x; git add -A && git commit -m x && git push origin y",
				),
			).toBe("checkUngated");
			expect(
				findDeny(
					"timeout 400 node_modules/.bin/vitest run t.test.ts && git add -A && git commit -m x && git push origin y",
				),
			).toBeNull();
		});

		it("npm test and npm t are checks", () => {
			expect(findDeny("npm test 2>&1 | tail; git commit -m x")).toBe(
				"checkUngated",
			);
			expect(findDeny("npm test && git commit -m x")).toBeNull();
			expect(findDeny("npm t 2>&1 | tail; git commit -m x")).toBe(
				"checkUngated",
			);
		});

		it("a timeout-wrapped, unrelated binary is still not a check", () => {
			expect(
				findDeny(
					"timeout 30 node_modules/.bin/oxfmt --check x.ts ; git commit -m x",
				),
			).toBeNull();
		});
	});

	it("no preceding check at all allows -- this is not a general 'write must be && or terminal' rule (it would deny the repo's own sanctioned `commit; status` pattern)", () => {
		expect(findDeny('git commit -m "x" ; git status')).toBeNull();
		expect(findDeny("echo hi; git push origin y")).toBeNull();
	});

	it("the backward search for the nearest check stops at an earlier write", () => {
		// npm run lint DOES gate the push (&&); the commit that follows is a
		// fresh boundary, not judged against the lint check at all.
		expect(
			findDeny("npm run lint && git push origin y ; git commit -m x"),
		).toBeNull();
	});

	it("a check piped to a filter (grep/tail/head) before an unconditional write -- the pipeline's exit status is the FILTER's, not the check's", () => {
		expect(
			findDeny(
				"npm run build 2>&1 | tail -1 && git add -A && git commit -m x && git push origin y",
			),
		).toBe("checkUngated");
	});

	it("shell control flow (if/then/fi deciding from a saved $?) is left alone rather than guessed at", () => {
		// This repo's OWN convention (audited in the corpus, PR body): save
		// the check's exit code, then gate through `if`, not `&&`. A pure
		// separator scan cannot see that gate, so it stands aside entirely
		// rather than deny a properly-gated write.
		expect(
			findDeny(
				"npm run build; vexit=$?; if [ $vexit -eq 0 ]; then git add -A && git commit -m x; fi",
			),
		).toBeNull();
	});

	it("splitSegmentsWithSeparators tags each segment with its preceding separator, null for the first", () => {
		expect(splitSegmentsWithSeparators("a && b || c ; d | e & f\ng")).toEqual([
			{ text: "a ", sep: null },
			{ text: " b ", sep: "&&" },
			{ text: " c ", sep: "||" },
			{ text: " d ", sep: ";" },
			{ text: " e ", sep: "|" },
			{ text: " f", sep: "&" },
			{ text: "g", sep: "\n" },
		]);
	});

	// #3471 review F3: the control-flow exemption moved from whole-REGION to
	// per-WRITE (a backward walk that stops at the nearest opener or closer),
	// because a region can carry an EARLIER, already-closed construct beside
	// a LATER, genuinely ungated check -> write the old whole-region skip
	// could not tell apart. Real corpus row e3cbc7a3 is this shape.
	describe("per-write control-flow scoping (review F3)", () => {
		it("an earlier, closed for/do/done loop does not exempt a later ungated write (corpus e3cbc7a3)", () => {
			expect(
				findDeny(
					"for f in a; do :; done; npx vitest run tests/config/hook-await-bounds.test.ts 2>&1 | grep -E 'Tests |Test Files'; git add x && git commit -m y && git push z",
				),
			).toBe("checkUngated");
		});

		it("a trivial if/fi with nothing inside still denies the write after it", () => {
			expect(
				findDeny(
					"npm run lint 2>&1 | tail; if true; then :; fi; git push origin y",
				),
			).toBe("checkUngated");
		});

		it("a trivial for/do/done with nothing inside still denies the write after it", () => {
			expect(
				findDeny(
					"npm run lint 2>&1 | tail; for f in a; do :; done; git push origin y",
				),
			).toBe("checkUngated");
		});

		it("the vexit convention still allows -- the write's nearest control-flow word is an opener (then), not a closer", () => {
			expect(
				findDeny(
					"npm run build; vexit=$?; if [ $vexit -eq 0 ]; then git add -A && git commit -m x; fi",
				),
			).toBeNull();
		});

		it("a while/do/done convention also still allows", () => {
			expect(
				findDeny(
					"npm run build; vexit=$?; while [ $vexit -eq 0 ]; do git add -A && git commit -m x; break; done",
				),
			).toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------
// #3471 lexer fix: a redirection `&` is not a segment separator
// ---------------------------------------------------------------------------
//
// Found building #3471's chain scan: `2>&1`'s lone `&` matched the plain
// SEGMENT_SEPARATOR regex unconditionally, splitting `npm run lint
// >/dev/null 2>&1 && git commit …` (the issue's own case 1, rewritten with
// `&&` -- exactly the form checkUngated must ALLOW) into bogus segments and
// corrupting the separator a later segment was tagged with. Measured against
// real bash in the PR body (`2>&1`, `>f 2>&1`, `&> f`, `1>&2` are all single
// redirection tokens, never a background operator or half of `&&`).
describe("scripts/hooks/guard-bash.mjs -- a redirection `&` is not a segment separator (#3471)", () => {
	it("2>&1 does not break a following && chain", () => {
		expect(
			findDeny("npm run lint >/dev/null 2>&1 && git commit -m x"),
		).toBeNull();
		expect(splitSegments("echo hi >/dev/null 2>&1 && echo bye")).toEqual([
			"echo hi >/dev/null 2>&1 ",
			" echo bye",
		]);
	});

	it("a bare stdout-to-file redirect then 2>&1 still keeps one segment", () => {
		expect(
			splitSegmentsWithSeparators("echo hi >f.log 2>&1 && echo bye"),
		).toEqual([
			{ text: "echo hi >f.log 2>&1 ", sep: null },
			{ text: " echo bye", sep: "&&" },
		]);
	});

	it("1>&2 (duplicating stdout onto stderr) is the same shape, reversed", () => {
		expect(splitSegments("echo hi 1>&2 && echo bye")).toEqual([
			"echo hi 1>&2 ",
			" echo bye",
		]);
	});

	it("bash's &> (redirect both) form is recognized from the OTHER side (& followed by >)", () => {
		expect(splitSegments("echo hi &> f.log && echo bye")).toEqual([
			"echo hi &> f.log ",
			" echo bye",
		]);
	});

	it("a REAL background & (not adjacent to a redirect operator) is still a live separator", () => {
		expect(findDeny("sleep 1 & git stash")).toBe("stash");
		expect(splitSegments("sleep 1 & git stash")).toEqual([
			"sleep 1 ",
			" git stash",
		]);
	});

	it("&& is still recognized as one two-character separator, not defeated by the redirect-ampersand check", () => {
		expect(splitSegments("echo hi && echo bye")).toEqual([
			"echo hi ",
			" echo bye",
		]);
	});
});

describe("scripts/hooks/guard-bash.mjs -- node probe repository ownership (#3680)", () => {
	it("allows a node file outside this repository, including after cd", () => {
		const otherRepo = mkdtempSync(join(tmpdir(), "pi-lens-3680-other-repo-"));
		const foreignDir = mkdtempSync(join(tmpdir(), "pi-lens-3680-foreign-dir-"));
		try {
			mkdirSync(join(otherRepo, "dist"));
			gitExecFileSync("git", ["init", "--quiet", otherRepo], {
				stdio: "ignore",
			});
			expect(
				runHook(`node ${otherRepo}/dist/cli.js --help`, {}, repoRoot).status,
			).toBe(0);
			expect(
				runHook(`cd ${otherRepo} && node dist/cli.js --help`, {}, repoRoot)
					.status,
			).toBe(0);
			expect(
				runHook(
					`cd ${foreignDir} && node dist/cli.js --help`,
					BASE_ENV,
					repoRoot,
				).status,
			).toBe(0);
			// A nonexistent cd target is unknowable to the static guard, so the
			// conservative probe denial remains pinned.
			expect(
				runHook(
					`cd ${join(foreignDir, "missing")} && node dist/cli.js --help`,
					BASE_ENV,
					repoRoot,
				).status,
			).toBe(2);
		} finally {
			rmSync(otherRepo, { recursive: true, force: true });
			rmSync(foreignDir, { recursive: true, force: true });
		}
	});

	it("denies a runtime file in this checkout, including a plain clone", () => {
		expect(
			runHook(
				`node ${join(repoRoot, "clients", "probe.mjs")}`,
				BASE_ENV,
				repoRoot,
			).status,
		).toBe(2);
	});

	it("denies a runtime file reached through a symlink", () => {
		const linkRoot = mkdtempSync(join(tmpdir(), "pi-lens-3680-link-"));
		try {
			symlinkSync(join(repoRoot, "clients"), join(linkRoot, "clients"));
			expect(
				runHook(
					`node ${join(linkRoot, "clients", "probe.mjs")}`,
					BASE_ENV,
					repoRoot,
				).status,
			).toBe(2);
		} finally {
			rmSync(linkRoot, { recursive: true, force: true });
		}
	});

	it("pins the process-cwd initialIdentity fallback for a relative probe", () => {
		const previous = process.env.PI_LENS_HOME;
		delete process.env.PI_LENS_HOME;
		try {
			expect(classifySegment("node clients/probe.mjs")).toBe("probe");
			expect(
				classifySegment(
					`node ${join(repoRoot, "clients", "probe.mjs")}`,
					{},
					"/tmp/3688-foreign-cwd",
					null as unknown as undefined,
				),
			).toBe("probe");
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previous;
		}
	});
});

// #3778: the "hooks always run" rule (docs/pi-lens-subagent.md: never
// `--no-verify`, `-n`, `-c core.hooksPath=…`, `HUSKY=0`) lived only as prose.
// Recurrences this block names, so it does not ship as a speculative guard:
//   - #3703: a worker pushed with `--no-verify` and 56 files were red in CI.
//   - 2026-09-30 (orchestrator): `git commit --no-verify -m x` was used for a
//     scratch probe commit and guard-bash let it through with rc=0.
// False positives cost more than misses here (every Bash call runs this
// hook), so the allow rows below are the half of the contract that matters.
describe("scripts/hooks/guard-bash.mjs -- git hook bypass (#3778)", () => {
	const DENY: string[] = [
		// the two incident shapes, verbatim
		"git commit --no-verify -m x",
		"git push --no-verify origin fix/3703-x",
		// the other three subcommands the issue names
		"git merge --no-verify origin/master",
		"git rebase --no-verify origin/master",
		"git rebase -m --no-verify origin/master", // rebase -m takes no value
		// git accepts the unambiguous abbreviations (r1 F3)
		"git commit --no-veri -m x",
		"git commit --no-verif -m x",
		"git push --no-veri origin y",
		"git push --no-verif origin y",
		"git rebase --no-veri origin/master",
		"git merge --no-verif origin/master",
		// a bundle ending on -m/-F takes the NEXT token as its value, and a
		// later -n is still a flag
		"git commit -am x -n",
		"git commit -aF msg.txt -n",
		"git commit -mx -n", // glued message, so -n is the NEXT flag
		"git commit -au -n", // -u takes only a glued mode, so -n is a flag
		// -n means --no-verify on `git commit`, alone or bundled
		"git commit -n -m x",
		"git commit -anm x",
		"git commit -m x -n",
		// global options before the subcommand do not hide it
		"git -C /some/worktree commit --no-verify -m x",
		'git -C "/some dir" push --no-verify',
		"git -c x=y commit --no-verify -m x",
		"git -c user.name=a -C /w push --no-verify",
		// a core.hooksPath override on the command line
		"git -c core.hooksPath=/dev/null commit -m x",
		"git -c core.hookspath=/dev/null push origin y",
		"git -c core.hooksPath= commit -m x",
		"git --config-env=core.hooksPath=NOHOOKS commit -m x",
		// a core.hooksPath WRITE, in every spelling a write can take
		"git config core.hooksPath /dev/null",
		"git config --local core.hooksPath /dev/null",
		"git config --global core.hooksPath ''",
		"git config --unset core.hooksPath",
		"git config --unset-all core.hooksPath",
		"git config --add core.hooksPath /x",
		"git config set core.hooksPath /x",
		"git config unset core.hooksPath",
		"git config core.hookspath /x",
		// the bypass variables the repo's hook runner honours
		"HUSKY=0 git commit -m x",
		'HUSKY="0" git push origin y',
		"env HUSKY=0 git commit -m x",
		"PI_LENS_SKIP_HOOKS=1 git push origin y",
		"PI_LENS_SKIP_HOOKS=0 git commit -m x",
		"export HUSKY=0; git commit -m x",
		// inside a substitution, and after a chain
		'echo "$(git commit --no-verify -m x)"',
		"git add -A && git commit --no-verify -m x",
	];

	it.each(DENY)("denies %j through the real hook entry", (command) => {
		const result = runHook(command);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("hook");
		// the one-line teaching message names the sanctioned path
		expect(result.stderr).toContain("scripts/red-on-base.mjs");
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
	});

	const ALLOW: string[] = [
		// -n is not a bypass outside `git commit`
		"git log -n 5",
		"head -n 5 file.txt",
		"git push -n origin y", // --dry-run, not --no-verify
		"git push --dry-run origin y",
		"git merge -n origin/master", // --no-stat
		"git diff -n",
		// flag text that is a message/body, not a flag
		'git commit -m "drop --no-verify from the runbook"',
		'git commit -m "--no-verify"',
		'git commit -m "-n"',
		// a bundle ending on -m/-F: the detached value is text (r1 F4)
		'git commit -am "-n"',
		'git commit -sm "-n"',
		'git commit -am "--no-verify"',
		"git commit -aF -n",
		"git commit --no-ver -m x", // ambiguous: git itself rejects it
		'git commit --message "--no-verify"',
		'git commit -F "-n"',
		'git commit --file "--no-verify"',
		'git merge -m "--no-verify" origin/master',
		'git merge -F "--no-verify" origin/master',
		"git commit -F msg.txt",
		"git commit -am x",
		"git commit -mn",
		"git commit -unormal -m x",
		"git commit --no-edit --amend",
		"git commit -m x -- -n",
		// heredoc, quoted PR body, --body-file: inert
		"git commit -F - <<'EOF'\nsubject\n\nmentions --no-verify and HUSKY=0\nEOF",
		"git commit -m \"$(cat <<'EOF'\nbody with git commit --no-verify\nEOF\n)\"",
		'gh pr create --title t --body "never use --no-verify or -n"',
		"gh pr create --title t --body-file PR_BODY.md",
		"gh pr edit 1 --body-file PR_BODY.md",
		"echo git commit --no-verify # a comment about it",
		"git commit -m x # --no-verify",
		// global options without a bypass
		"git -c x=y commit -m x",
		"git -C /some/worktree commit -m x",
		"git -c user.name=a push origin y",
		// core.hooksPath READS, which setup-git-hooks.mjs itself does
		"git config core.hooksPath",
		"git config --get core.hooksPath",
		"git config --local --get core.hooksPath",
		"git config get core.hooksPath",
		"git config core.hooksPath --local",
		"git config core.editor vim",
		// env that is not the bypass, or not on a hook-running git command
		"HUSKY=1 git commit -m x",
		"HUSKY=0 npm install",
		"PI_LENS_SKIP_HOOKS= git commit -m x",
		"HUSKY=0 git status",
		"echo HUSKY=0",
		"export HUSKY=0",
		// the sanctioned, recorded pre-push lock opt-out (#3717)
		"PI_LENS_PREPUSH_LOCK_SKIP=1 git push origin y",
		// subcommands the rule does not cover
		"git -c core.hooksPath=/x status",
		"git log --no-verify",
	];

	it.each(ALLOW)("allows %j through the real hook entry", (command) => {
		const result = runHook(command);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	// -<letter>n... with a value-taking letter first is a value, not `-n`.
	it.each([..."mFCctuS"])("commit -%s<value with n> is not a bypass", (l) => {
		expect(findDeny(`git commit -${l}nx`)).toBeNull();
	});

	// r1 F1: a core.hooksPath write is denied whatever the value (the repair
	// `git config core.hooksPath .husky/_` is in the maintainer's transcripts),
	// so the message must name the sanctioned repair instead.
	it("a core.hooksPath write names setup-git-hooks as the repair", () => {
		const result = runHook("git config core.hooksPath /x/.husky/_");
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("node scripts/setup-git-hooks.mjs");
	});

	it("declares hookBypass in the DenyRule union the .d.mts exports", () => {
		// Same guard as the sibling rule declarations: remove "hookBypass" from
		// the union and `npm run lint` fails with TS2322 before the suite runs.
		const rule: DenyRule = "hookBypass";
		expect(RULE_MESSAGES[rule]).toContain("red-on-base");
	});

	// Recurrence this prevents: a fourth skip variable added to a husky hook
	// that this guard never learns about (the same hand-list-mirroring-a-
	// -registry drift the repo's single-source rule names). The names are read
	// from the hooks' own `if [ -n "$NAME" ]` opt-outs and from husky's own
	// dispatcher, so a new opt-out reds here instead of shipping unguarded.
	it("denies every skip variable the repo's hook runner honours", () => {
		const names = new Set<string>();
		for (const hookFile of ["pre-commit", "pre-push"]) {
			const text = readFileSync(join(repoRoot, ".husky", hookFile), "utf8");
			for (const m of text.matchAll(/\[ -n "\$([A-Z_]+)" \]/g)) names.add(m[1]);
		}
		expect([...names]).toContain("PI_LENS_SKIP_HOOKS");
		for (const name of names)
			expect(findDeny(`${name}=1 git commit -m x`), name).toBe("hookBypass");
		const dispatcher = readFileSync(
			join(repoRoot, "node_modules", "husky", "husky"),
			"utf8",
		);
		expect(dispatcher).toContain('[ "${HUSKY-}" = "0" ] && exit 0');
		expect(findDeny("HUSKY=0 git commit -m x")).toBe("hookBypass");
	});
});

// #3787: two helpers every git rule shares. Both populations were measured
// against real bash 5.3 and git 2.53, not read from the issue:
//   - Keywords that run the NEXT word as a command: do, then, else, elif, if,
//     while, until, `!`, coproc (each created its side-effect file in a probe).
//     Excluded on purpose: case/esac/fi/done/in/select and `function f {`,
//     which run nothing at that word (a `case` arm is split off by `)`).
//   - Git globals that take a SEPARATE value token: -C, -c, --git-dir,
//     --work-tree, --namespace, --config-env, --attr-source. Excluded:
//     --exec-path (its value form is `=` only; a bare one just prints the
//     path) and --super-prefix (git 2.53 rejects it as an unknown option).
describe("scripts/hooks/guard-bash.mjs -- shell keywords and separate-token git globals (#3787)", () => {
	const KEYWORD_SHAPES: Array<[name: string, wrap: (cmd: string) => string]> = [
		["do", (c) => `for b in x; do ${c}; done`],
		["then", (c) => `if true; then ${c}; fi`],
		["else", (c) => `if false; then :; else ${c}; fi`],
		["elif", (c) => `if false; then :; elif ${c}; then :; fi`],
		["if", (c) => `if ${c}; then :; fi`],
		["while", (c) => `while ${c}; do break; done`],
		["until", (c) => `until ${c}; do break; done`],
		["bang", (c) => `! ${c}`],
		["coproc", (c) => `coproc ${c}`],
		["keyword then runner prefix", (c) => `if true; then command ${c}; fi`],
		["keyword then brace", (c) => `if true; then { ${c}; }; fi`],
	];
	const GUARDED: Array<[command: string, rule: DenyRule]> = [
		["git stash", "stash"],
		["git reset --hard", "reset"],
		["git worktree remove -f -f ../w", "worktreeForce"],
		["git push --no-verify origin y", "hookBypass"],
		["git commit -n -m x", "hookBypass"],
		["git push --force origin y", "forcePush"],
		["git rebase origin/master", "rebase"],
	];

	describe.each(KEYWORD_SHAPES)("after %s", (_name, wrap) => {
		it.each(GUARDED)("denies %j", (command, rule) => {
			expect(findDeny(wrap(command))).toBe(rule);
		});
	});

	it("denies a keyword-led hook bypass through the real hook entry", () => {
		const result = runHook("for b in x; do git push --no-verify; done");
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("scripts/red-on-base.mjs");
		expect(runHook("if true; then git commit -n; fi").status).toBe(2);
	});

	it("classifies a guarded command in a named brace-form coproc", () => {
		// Pure parser seam: neither this fixture nor the test launches Bash or
		// executes its payload.
		const command = 'coproc C { git stash; }; wait "$COPROC_PID"';
		expect(findDeny(command)).toBe("stash");
	});

	// #3787 mutation follow-up: braces group commands but do not gate a
	// failed check; excluding every keyword must not also exclude `{`.
	it.each(["git commit -m x", "git push"])(
		"denies an ungated %s after a brace-led check",
		(write) => {
			expect(findDeny(`{ npm test; }; ${write}`)).toBe("checkUngated");
			expect(findDeny(`{ npm test && ${write}; }`)).toBeNull();
		},
	);

	const GLOBAL_FLAGS: string[] = [
		"--git-dir x",
		"--work-tree x",
		"--namespace x",
		"--config-env k=V",
		"--attr-source HEAD",
		"-C x --git-dir y --work-tree z",
	];

	describe.each(GLOBAL_FLAGS)("after the global %s", (flags) => {
		it.each(GUARDED)("denies %j", (command, rule) => {
			const [, ...rest] = command.split(" ");
			expect(findDeny(`git ${flags} ${rest.join(" ")}`)).toBe(rule);
		});
	});

	// The other direction: a global that takes NO separate value must not
	// swallow the subcommand after it.
	it.each([
		"--no-pager",
		"--bare",
		"-p",
		"--literal-pathspecs",
		"--exec-path=/x",
		"--git-dir=x",
	])("a valueless global %s does not hide the subcommand", (flag) => {
		expect(findDeny(`git ${flag} stash`)).toBe("stash");
	});

	it("sees core.hooksPath given as a separate --config-env value", () => {
		expect(
			findDeny("git --config-env core.hooksPath=NOHOOKS commit -m x"),
		).toBe("hookBypass");
		expect(
			findDeny("git --config-env core.hooksPath=NOHOOKS push origin y"),
		).toBe("hookBypass");
		expect(
			findDeny(
				"for b in x; do git --git-dir x --config-env core.hooksPath=H commit; done",
			),
		).toBe("hookBypass");
	});

	const ALLOW: string[] = [
		// the keyword word as an argument, not a command word
		"echo then git stash",
		"echo do; git status",
		'grep -n "then git stash" notes.txt',
		"printf '%s' else",
		// keyword-led commands that are not guarded
		"for b in x; do git status; done",
		"if true; then git log -n 5; fi",
		"if git diff --quiet; then git commit -m x; fi",
		"while git fetch origin; do break; done",
		"! git diff --quiet",
		"for b in x; do git push origin y; done",
		'if true; then git commit -m "mentions --no-verify and -n"; fi',
		"for b in x; do git reset --mixed HEAD; done",
		"for b in x; do git worktree remove -f ../w; done",
		// a loop or branch that gates on a check stays a gate for the chain
		// scan (#3471): the keyword word is not itself a check segment
		"if ! npm test; then exit 1; fi; git commit -m x",
		"if npm test; then echo ok; fi; git commit -m x",
		"while ! npm test; do sleep 1; done; git push",
		"until npm test; do sleep 1; done && git commit -m x",
		// a separate global's value that spells a guarded subcommand
		"git --git-dir stash status",
		"git --work-tree stash status",
		"git --namespace stash log",
		"git --config-env user.name=stash status",
		"git --attr-source stash status",
		// global options that are not a bypass
		"git --git-dir x commit -m x",
		"git --work-tree x push origin y",
		"git --namespace ns push origin y",
		"git --config-env user.name=NAME commit -m x",
		'git --git-dir x commit -m "--no-verify"',
		"git --git-dir=x --work-tree=y status",
		"git --no-pager log -n 5",
		"git --config-env core.hooksPath=H status",
	];

	it.each(ALLOW)("allows %j through the real hook entry", (command) => {
		const result = runHook(command);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("still does not claim sh -c, eval, xargs or nice/timeout/env -i prefixes", () => {
		expect(findDeny("sh -c 'git stash'")).toBeNull();
		expect(findDeny('eval "git stash"')).toBeNull();
		expect(findDeny("echo x | xargs git stash")).toBeNull();
		expect(findDeny("nice -n 10 git stash")).toBeNull();
		expect(findDeny("timeout 30 git stash")).toBeNull();
		expect(findDeny("env -i git stash")).toBeNull();
		expect(findDeny("GIT_CONFIG_KEY_0=core.hooksPath git commit")).toBeNull();
	});
});

describe("scripts/hooks/guard-bash.mjs -- branch history guard (#3888)", () => {
	it("teaches merge-over-rebase and explicit lease authorization", () => {
		const rebase = runHook("git rebase origin/master");
		expect(rebase.status).toBe(2);
		expect(rebase.stderr).toContain("merge `origin/master`");
		const force = runHook("git push --force origin branch");
		expect(force.status).toBe(2);
		expect(force.stderr).toContain("explicit orchestrator authorization");
	});

	it("declares the new rules in the typed export", () => {
		const force: DenyRule = "forcePush";
		const rebase: DenyRule = "rebase";
		expect(RULE_MESSAGES[force]).toContain("origin/master");
		expect(RULE_MESSAGES[rebase]).toContain("origin/master");
	});
});
