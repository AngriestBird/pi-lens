// Sampling and formatting for `scripts/with-memory-watch.mjs` (#2042).
//
// Kept separate from the wrapper so the parsing and the print policy are unit
// testable without spawning a child process.

import * as fs from "node:fs";
import * as os from "node:os";

const MB = 1024 * 1024;

/**
 * Available memory, in MB, as the OS reports it.
 *
 * `/proc/meminfo`'s MemAvailable is the number the Linux OOM killer's pressure
 * actually tracks: `os.freemem()` excludes reclaimable page cache and reads
 * alarmingly low on a healthy runner, which would make every sample look like
 * an emergency. Fall back to `os.freemem()` off Linux, where this wrapper is
 * only ever a no-op passthrough anyway.
 *
 * @param {string} [meminfoPath]
 * @returns {{ totalMb: number, availableMb: number, source: "meminfo" | "os" }}
 */
export function readMemory(meminfoPath = "/proc/meminfo") {
	try {
		return parseMeminfo(fs.readFileSync(meminfoPath, "utf8"));
	} catch {
		return {
			totalMb: Math.round(os.totalmem() / MB),
			availableMb: Math.round(os.freemem() / MB),
			source: "os",
		};
	}
}

/**
 * @param {string} text
 * @returns {{ totalMb: number, availableMb: number, source: "meminfo" }}
 */
export function parseMeminfo(text) {
	const field = (name) => {
		const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text);
		if (!match) throw new Error(`meminfo has no ${name}`);
		return Math.round(Number(match[1]) / 1024);
	};
	return {
		totalMb: field("MemTotal"),
		availableMb: field("MemAvailable"),
		source: "meminfo",
	};
}

/**
 * Print policy. A sample every few seconds for a five-minute suite would bury
 * the test output, so a sample is only worth a line when it says something new:
 * the first one, a fall past the low-water threshold, or a big step down from
 * the last line printed.
 *
 * @param {{ availableMb: number }} sample
 * @param {{ lastPrintedMb: number | null, thresholdMb: number, stepMb: number }} state
 * @returns {boolean}
 */
export function shouldPrint(sample, state) {
	if (state.lastPrintedMb === null) return true;
	if (sample.availableMb <= state.thresholdMb) return true;
	return state.lastPrintedMb - sample.availableMb >= state.stepMb;
}

/**
 * The verdict line. Exit 137 with no failing assertion is the whole problem
 * this wrapper exists for: on its own it reads as infrastructure noise and
 * costs a judged rerun. Naming the low-water mark turns it into a claim about
 * memory that the next reader can act on.
 *
 * @param {{ code: number | null, signal: string | null }} exit
 * @param {{ totalMb: number, lowWaterMb: number, lowWaterAt: string | null }} watch
 * @returns {string}
 */
export function formatVerdict(exit, watch) {
	const status =
		exit.signal !== null
			? `signal=${exit.signal}`
			: `exitCode=${exit.code ?? "null"}`;
	const oomShaped = exit.signal === "SIGKILL" || exit.code === 137;
	const head = oomShaped
		? "[mem-watch] KILLED — no failing assertion means the OS reclaimed memory, not a test failure."
		: "[mem-watch] done.";
	return (
		`${head} ${status} totalMb=${watch.totalMb} ` +
		`lowWaterAvailableMb=${watch.lowWaterMb}` +
		(watch.lowWaterAt ? ` lowWaterAt=${watch.lowWaterAt}` : "")
	);
}
