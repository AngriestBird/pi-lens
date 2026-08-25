#!/usr/bin/env node
/**
 * scripts/with-memory-watch.mjs (#2042)
 *
 * Runs a command while sampling host memory, so an OOM kill leaves evidence.
 *
 * The problem it solves is not memory use, it is memory ATTRIBUTION. The CI
 * Unit-tests job was SIGKILLed repeatedly with `Killed npm test` and exit 137
 * and zero failing assertions. That output names no file, no process, and no
 * number, so every occurrence reads as infrastructure noise and costs a judged
 * rerun. This wrapper prints the host's memory low-water mark and a verdict
 * line, so the next exit 137 is a claim about memory that a reader can check.
 *
 * It never changes what runs, and it forwards the child's exit code and signal
 * unchanged -- a killed run still fails the job.
 *
 * Usage:
 *   node scripts/with-memory-watch.mjs -- <command> [args...]
 *
 * Env:
 *   PI_LENS_MEM_WATCH_INTERVAL_MS   Sampling period (default 2000).
 *   PI_LENS_MEM_WATCH_LOW_MB        Print every sample at or below this many
 *                                   MB available (default 1024).
 *   PI_LENS_MEM_WATCH_STEP_MB       Print when available memory has fallen this
 *                                   far since the last printed line
 *                                   (default 1024).
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import { formatVerdict, readMemory, shouldPrint } from "./lib/memory-watch.mjs";

const separator = process.argv.indexOf("--");
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (command.length === 0) {
	process.stderr.write(
		"usage: node scripts/with-memory-watch.mjs -- <command> [args...]\n",
	);
	process.exit(2);
}

const intervalMs = Number(process.env.PI_LENS_MEM_WATCH_INTERVAL_MS) || 2000;
const thresholdMb = Number(process.env.PI_LENS_MEM_WATCH_LOW_MB) || 1024;
const stepMb = Number(process.env.PI_LENS_MEM_WATCH_STEP_MB) || 1024;

const first = readMemory();
process.stdout.write(
	`[mem-watch] host cpus=${os.availableParallelism?.() ?? os.cpus().length} ` +
		`totalMb=${first.totalMb} availableMb=${first.availableMb} ` +
		`source=${first.source} intervalMs=${intervalMs}\n`,
);

const watch = {
	totalMb: first.totalMb,
	lowWaterMb: first.availableMb,
	lowWaterAt: null,
};
const state = { lastPrintedMb: null, thresholdMb, stepMb };

const timer = setInterval(() => {
	const sample = readMemory();
	const at = new Date().toISOString().slice(11, 19);
	if (sample.availableMb < watch.lowWaterMb) {
		watch.lowWaterMb = sample.availableMb;
		watch.lowWaterAt = at;
	}
	if (shouldPrint(sample, state)) {
		state.lastPrintedMb = sample.availableMb;
		process.stdout.write(
			`[mem-watch] ${at} availableMb=${sample.availableMb} of ${sample.totalMb}\n`,
		);
	}
}, intervalMs);
// The watcher must never be the reason the process stays alive.
timer.unref?.();

const child = spawn(command[0], command.slice(1), {
	stdio: "inherit",
	shell: process.platform === "win32",
});

child.on("error", (error) => {
	clearInterval(timer);
	process.stderr.write(`[mem-watch] failed to spawn: ${error.message}\n`);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	clearInterval(timer);
	process.stdout.write(`${formatVerdict({ code, signal }, watch)}\n`);
	// Re-raising the signal would make this wrapper's own death the story. Map
	// it to the shell's 128+n instead, which is the code CI already reports.
	if (signal) process.exit(128 + (os.constants.signals[signal] ?? 0));
	process.exit(code ?? 1);
});
