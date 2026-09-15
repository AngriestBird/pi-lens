import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const wrapper = path.join(repoRoot, "scripts/with-memory-watch.mjs");

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Run the wrapper and collect everything it wrote.
 *
 * `throttleMs` starves the stdout reader: each chunk pauses the stream and
 * resumes it after the delay, so the OS pipe backs up while the wrapped command
 * is still producing output. That is the state the wrapper is in when a CI log
 * collector falls behind, and it is where an asynchronously queued write is
 * lost to `process.exit`.
 *
 * `extraEnv` (round-2 review F4) merges over the inherited environment --
 * folded in here rather than kept as a second, near-duplicate spawn helper
 * (the net-count rule: `runWrapperWithEnv` repeated 18 of this function's 24
 * lines for one added `env` key).
 */
function runWrapper(
	args: string[],
	throttleMs = 0,
	extraEnv: Record<string, string> = {},
): Promise<Run> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [wrapper, ...args], {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...extraEnv },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (throttleMs > 0) {
				child.stdout.pause();
				setTimeout(() => child.stdout.resume(), throttleMs);
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

// The wrapper spawns through a shell on Windows (it has to: `npm` is not
// executable there), and `shell: true` concatenates arguments without escaping
// them. `process.execPath` is `C:\Program Files\nodejs\node.exe` on a default
// install, so the space would split the command. Use the bare name off PATH
// there, and keep every `-e` script free of spaces for the same reason. This is
// the limitation the wrapper's own comment warns about, met first-hand.
const nodeCmd = process.platform === "win32" ? "node" : process.execPath;

/** A child that exits with `code` after writing nothing. */
const exitWith = (code: number) => [
	"--",
	nodeCmd,
	"-e",
	`process.exitCode=${code}`,
];

describe("with-memory-watch exit forwarding (#2042)", () => {
	it("forwards a non-zero child exit code", async () => {
		// The wrapper must never soften a failure into a pass. A killed suite has
		// to keep failing the job.
		const run = await runWrapper(exitWith(3));
		expect(run.code).toBe(3);
	});

	it("forwards a clean child exit", async () => {
		const run = await runWrapper(exitWith(0));
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("[mem-watch] done.");
	});

	it("rejects a usage error with 2", async () => {
		// No `--` separator: nothing to run.
		const run = await runWrapper([]);
		expect(run.code).toBe(2);
		expect(run.stderr).toContain("usage:");
	});

	it("reports a command it cannot spawn with 1", async () => {
		const run = await runWrapper([
			"--",
			"pi-lens-no-such-binary-2042",
			"--version",
		]);
		expect(run.code).toBe(1);
	});
});

describe("with-memory-watch verdict durability (#2042)", () => {
	it("routes every record through a blocking write", () => {
		// The behavioural case below is the real proof, but it can only FAIL on
		// Linux. Windows discards pipe-buffered bytes at process teardown even
		// after `fs.writeSync` reports a complete write (#2093 verify: `ok
		// bytes=86 of 86`, nothing at the reader), so no write mechanism makes
		// the loss reproducible-then-fixed there. CI is Linux, which is exactly
		// where the fix holds and where nobody is watching.
		//
		// So pin the mechanism too, on every platform: no record may go out
		// through `process.stdout.write` or `process.stderr.write`, whose queued
		// bytes `process.exit` discards on Linux. Reverting any `emit(...)` call
		// to a stream write reds here regardless of OS. On a dev box this text
		// pin is the only thing holding the ratchet.
		const source = fs.readFileSync(wrapper, "utf8");
		const offending = source
			.split("\n")
			.map((line, index) => ({ line: line.trim(), number: index + 1 }))
			.filter(
				(entry) =>
					/process\.std(out|err)\.write/.test(entry.line) &&
					!entry.line.startsWith("*") &&
					!entry.line.startsWith("//"),
			);
		expect(
			offending,
			"use emit() (fs.writeSync) so process.exit cannot discard the record",
		).toEqual([]);
	});

	it("writes the verdict even when the log reader has fallen behind", async () => {
		// 4 MB through a 64 KB pipe against a reader that stalls 20ms per chunk:
		// by the time the child exits, the pipe is full, so an asynchronously
		// queued `process.stdout.write` is still pending when `process.exit`
		// discards it. The #2093 review reproduced that 3/3 on Linux — correct
		// exit code, no verdict line — losing the record in exactly the
		// memory-pressured run this wrapper exists to explain. A blocking
		// `fs.writeSync(1, ...)` survives on Linux. This case cannot fail on
		// Windows at these parameters, and a heavier probe (18 MB, 4 KB reads)
		// fails there even WITH the fix (teardown discard, see the mechanism
		// guard) — if a Windows unit-test leg is ever added, expect this case to
		// flake for reasons unrelated to the code.
		const run = await runWrapper(
			["--", nodeCmd, "-e", "process.stdout.write('x'.repeat(4194304))"],
			20,
		);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("[mem-watch] done.");
		expect(run.stdout).toContain("lowWaterAvailableMb=");
	}, 60_000);
});

/**
 * Round-2 review N1. Both fields the verdict reads are set by the WRAPPER, and
 * both were pinned only at the formatter. Delete `intervalMs,` from the watch
 * object and every formatter test stays green: the shipped verdict silently
 * loses its cadence caveat and nothing notices. Same for the spawned pid, which
 * is what makes the kernel's "Killed process <pid>" line attributable.
 *
 * These are source-text pins for the same reason the durability mechanism above
 * is one: the behaviour they guard only appears in a real CI kill, which no
 * unit test can stage.
 */
describe("with-memory-watch verdict wiring (#2042)", () => {
	const source = (): string => fs.readFileSync(wrapper, "utf8");

	it("hands the sampling cadence to the verdict", () => {
		const literal = /const watch = \{([\s\S]*?)\n\};/.exec(source());
		expect(literal, "the wrapper's `watch` object literal").not.toBeNull();
		expect(
			literal?.[1],
			"watch.intervalMs feeds formatVerdict's cadence caveat",
		).toMatch(/^\s*intervalMs\b/m);
	});

	it("records the pid it spawned, so the kernel's victim is nameable", () => {
		expect(
			source(),
			"watch.childPid must be set from the spawned child",
		).toMatch(/watch\.childPid\s*=\s*child\.pid/);
	});
});

// flake-shape: raw-timer-wait — the poll loop below waits for the wrapper's
// OWN real setInterval sampling tick to reach disk, which cannot be faked
// from the test process (a separate real child process); a fixed sleep here
// flaked under concurrent vitest workers, so this waits for the actual
// condition (file exists) instead.
/**
 * #2042 2026-09-15 diagnosis, section A: the cheapest probe. End-to-end
 * through the real wrapper, not the library functions directly, so the wiring
 * between the interval tick and the on-disk file is what is under test.
 */
describe("with-memory-watch sample tail (#2042 2026-09-15)", () => {
	function makeSampleFile(): string {
		return path.join(
			os.tmpdir(),
			`pi-lens-mem-watch-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
		);
	}

	// Round-2 review F2: replaces the old ring-buffer "never grows past the
	// cap" case. The sampler no longer caps anything it writes -- an
	// append-only file can never lose an earlier line to a rewrite, which is
	// exactly what a fixed ring did on the real 2026-09-15 CI run (the tail
	// covered only the run's last 60s, 21:10:04-21:11:04, while the actual
	// low-water event -- what a kill would land near -- was at 21:02:18,
	// already scrolled out). What has to hold instead: one line per tick, in
	// order, never truncated, growing linearly with elapsed ticks.
	it("appends exactly one line per tick, in order, never truncating earlier lines", async () => {
		const sampleFile = makeSampleFile();
		try {
			await runWrapper(["--", nodeCmd, "-e", "setTimeout(() => {}, 250)"], 0, {
				PI_LENS_MEM_WATCH_INTERVAL_MS: "30",
				PI_LENS_MEM_WATCH_SAMPLE_FILE: sampleFile,
			});
			const lines = fs
				.readFileSync(sampleFile, "utf8")
				.split("\n")
				.filter(Boolean);
			// ~250ms / 30ms: at least 5 ticks fired, and NONE were trimmed --
			// the old ring, fed the same parameters, would have capped this at 2.
			expect(lines.length).toBeGreaterThanOrEqual(5);
			for (const line of lines) {
				expect(line).toMatch(
					/^\[mem-sample\] \d\d:\d\d:\d\d\.\d\d\d availableMb=\d+ totalMb=\d+ /,
				);
				expect(line).toMatch(/memCurrentMb=(\?|\d+) memPeakMb=(\?|\d+)/);
				expect(line).toMatch(/pids=(\?|\d+)/);
			}
			// Strictly increasing millisecond stamps: every tick's line survives,
			// none overwritten, none reordered.
			const stamps = lines.map(
				(line) => /\[mem-sample\] (\d\d:\d\d:\d\d\.\d\d\d)/.exec(line)?.[1],
			);
			const sorted = [...stamps].sort();
			expect(stamps).toEqual(sorted);
		} finally {
			fs.rmSync(sampleFile, { force: true });
		}
	}, 15_000);

	it("still leaves the sample file behind when the wrapper's own process is the one killed", async () => {
		// The master 1701d01 red: no verdict line, because the wrapper itself
		// died, not its child. That is exactly the case the file has to survive
		// -- proven here by killing the WRAPPER (not the child) mid-run and
		// checking the file anyway. Waits for the FIRST tick's write rather than
		// a fixed sleep, so this stays reliable under a loaded, contended box
		// (a fixed short sleep flaked here under concurrent vitest workers: the
		// wrapper's own process start can take longer than the sleep on a busy
		// host, which would make the kill land before the first tick and turn a
		// real fix into a flaky test).
		const sampleFile = makeSampleFile();
		try {
			const child = spawn(
				process.execPath,
				[wrapper, "--", nodeCmd, "-e", "setTimeout(() => {}, 30000)"],
				{
					cwd: repoRoot,
					stdio: "ignore",
					env: {
						...process.env,
						PI_LENS_MEM_WATCH_INTERVAL_MS: "30",
						PI_LENS_MEM_WATCH_SAMPLE_FILE: sampleFile,
					},
				},
			);
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(sampleFile)) {
				if (Date.now() > deadline) {
					child.kill("SIGKILL");
					throw new Error("sample file never appeared before the deadline");
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			child.kill("SIGKILL");
			// One more tick's worth of grace for the write that was already
			// in-flight when the kill landed to finish reaching disk.
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(fs.existsSync(sampleFile)).toBe(true);
			const lines = fs
				.readFileSync(sampleFile, "utf8")
				.split("\n")
				.filter(Boolean);
			expect(lines.length).toBeGreaterThan(0);
		} finally {
			fs.rmSync(sampleFile, { force: true });
		}
	}, 15_000);
});
