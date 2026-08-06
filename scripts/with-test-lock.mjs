#!/usr/bin/env node
/**
 * scripts/with-test-lock.mjs (#1101)
 *
 * Serializes full-suite test runs across a machine: multiple concurrent
 * `npm test` invocations (several agents on parallel worktrees, plus an
 * interactive run) spawn independently-sized fork pools
 * (`maxWorkers: "50%"`, 4GB/fork — vitest.config.ts) that assume a
 * dedicated machine. Run more than one at once and they fight over CPU/RAM,
 * producing vitest worker-crash cascades and timing-budget flakes that look
 * like real bugs but aren't (see AGENTS.md's testing-discipline section).
 *
 * This wrapper acquires ONE lock file before running the wrapped command,
 * and releases it after — so concurrent full-suite runs queue instead of
 * stomping on each other.
 *
 * Lock scope: MACHINE-WIDE, not per-repo. Worktrees of the same repo (or
 * entirely different repos) still contend for the same physical CPU/RAM, so
 * this deliberately does NOT key the lock to the repo root path the way
 * getProjectDataDir does for project caches — see scripts/lib/suite-lock.mjs.
 * Default location: `~/.pi-lens/test-suite.lock` (or
 * `$PI_LENS_HOME/test-suite.lock`).
 *
 * Pattern: atomic create (`fs.open(path, "wx")`) + PID-liveness staleness,
 * mirroring clients/installer/index.ts's `.install.lock` (AGENTS.md: "A
 * lock is stale only after its recorded PID is confirmed dead"). Waiting
 * prints a heartbeat line at least every 15s so a queued run never looks
 * hung.
 *
 * Usage:
 *   node scripts/with-test-lock.mjs -- <command> [args...]
 *   node scripts/with-test-lock.mjs -- vitest run
 *
 * Env:
 *   PI_LENS_TEST_NO_LOCK=1          Skip locking entirely (CI sets this —
 *                                   runners are isolated, one job per box).
 *   PI_LENS_TEST_LOCK_TIMEOUT_MS    Give up waiting after this long
 *                                   (default: wait forever).
 */

import { spawn } from "node:child_process";
import os from "node:os";
import { acquireTestLock, getLockPath } from "./lib/suite-lock.mjs";

function parseCommandArgs(argv) {
	const sepIndex = argv.indexOf("--");
	const rest = sepIndex === -1 ? argv : argv.slice(sepIndex + 1);
	return rest;
}

// Windows CreateProcess cannot exec .cmd/.bat files directly — they need
// cmd.exe as an interpreter (vitest.cmd/npx.cmd under node_modules/.bin are
// exactly this shape), which is why win32 needs `shell: true` here at all.
// But `shell: true` + an args ARRAY does NOT quote/escape for you on
// Windows (Node just space-joins argv into the command line) — confirmed
// experimentally: an arg containing a space silently split into two argv
// entries on the far side. So on win32 we build the command line ourselves
// with CRT-style quoting (the same quoting rule most Windows executables,
// including node.exe/npm's own shims, expect) and hand spawn() a single
// pre-quoted string instead of an args array.
//
// This is NOT a general shell-injection-safe escaper (no defense against
// cmd.exe metacharacters like &, |, %VAR% expansion) — that's the much
// larger surface `clients/safe-spawn.ts` covers for installer subprocess
// mutations. It doesn't need to be: commandArgs here always comes from this
// process's own argv (a package.json script definition — `vitest run
// --ignore ...`), never from untrusted external/user input.
function quoteForWindowsCmd(arg) {
	if (arg === "") return '""';
	if (!/[\s"^&|<>()%!]/.test(arg)) return arg;
	let result = "";
	let backslashes = 0;
	for (const ch of arg) {
		if (ch === "\\") {
			backslashes++;
			continue;
		}
		if (ch === '"') {
			result += "\\".repeat(backslashes * 2 + 1) + '"';
			backslashes = 0;
			continue;
		}
		result += "\\".repeat(backslashes) + ch;
		backslashes = 0;
	}
	result += "\\".repeat(backslashes * 2);
	return `"${result}"`;
}

function runCommand(commandArgs) {
	return new Promise((resolve, reject) => {
		const isWin32 = process.platform === "win32";
		const child = isWin32
			? spawn(commandArgs.map(quoteForWindowsCmd).join(" "), {
					stdio: "inherit",
					shell: true,
				})
			: spawn(commandArgs[0], commandArgs.slice(1), {
					stdio: "inherit",
					shell: false,
				});

		const forwardSignal = (signal) => {
			if (!child.killed) child.kill(signal);
		};
		process.once("SIGINT", forwardSignal);
		process.once("SIGTERM", forwardSignal);

		child.once("error", (error) => {
			process.removeListener("SIGINT", forwardSignal);
			process.removeListener("SIGTERM", forwardSignal);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			process.removeListener("SIGINT", forwardSignal);
			process.removeListener("SIGTERM", forwardSignal);
			if (signal) {
				const signalNumber = os.constants.signals[signal];
				resolve(typeof signalNumber === "number" ? 128 + signalNumber : 1);
			} else {
				resolve(code ?? 1);
			}
		});
	});
}

async function main() {
	const commandArgs = parseCommandArgs(process.argv.slice(2));
	if (commandArgs.length === 0) {
		console.error("Usage: node scripts/with-test-lock.mjs -- <command> [args...]");
		process.exitCode = 2;
		return;
	}

	if (process.env.PI_LENS_TEST_NO_LOCK === "1") {
		process.exitCode = await runCommand(commandArgs);
		return;
	}

	const lockPath = getLockPath();
	const lock = await acquireTestLock({
		lockPath,
		log: (message) => console.error(`[with-test-lock] ${message}`),
	});

	try {
		process.exitCode = await runCommand(commandArgs);
	} finally {
		await lock.release();
	}
}

main().catch((error) => {
	console.error(`[with-test-lock] ${error.message}`);
	process.exitCode = 1;
});
