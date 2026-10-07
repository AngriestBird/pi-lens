import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	removeTempDirSync,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { isProcessAlive } from "../support/process-tree.js";
import { waitForChildExit, withRealPi } from "../support/real-pi-harness.js";

// The one real spawn site of this file's helper-free children.
const spawnNode = (script: string, ...args: string[]): ChildProcess =>
	spawn(process.execPath, ["-e", script, ...args], {
		stdio: ["ignore", "pipe", "ignore"],
	});
const exited = (child: ChildProcess) =>
	new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else child.once("exit", () => resolve());
	});

// Writes new files into argv[1] back to back for argv[2] ms, then exits: the
// shape of a process still writing under a directory being removed. Tight on
// purpose: a gap between files lets one rmSync pass win the race.
const WRITER = `
const fs = require("fs"), p = require("path");
const dir = process.argv[1], end = Date.now() + Number(process.argv[2]);
let i = 0;
// Enough files that one removal pass outlasts a few writes (a near-empty
// directory can be removed between two of them, which is not the race).
for (; i < 2000; i++) fs.writeFileSync(p.join(dir, "f" + i), "x");
console.log("ready");
while (Date.now() < end) {
  try { fs.writeFileSync(p.join(dir, "f" + ++i), "x"); } catch {}
}`;

// Creates argv[1] and writes into it every 2 ms until it is killed: the
// reparented grandchild the real pi leaves behind (knip, ast-grep, tsserver).
// It exits by itself after 30 s: when close() fails to reap it, the test must
// not signal a pid the kill-guard no longer sees as this worker's (#2042).
const ORPHAN_WRITER = `
const fs = require("fs");
setTimeout(() => process.exit(0), 30000);
fs.mkdirSync(process.argv[1], { recursive: true });
setInterval(() => {
  try { fs.writeFileSync(process.argv[1] + "/f" + Math.random(), "x"); } catch {}
}, 2);`;

// flake-shape: real-process-spawn — child death is only observable at the real process boundary
describe("real pi harness: child lifecycle", () => {
	const stray: ChildProcess[] = [];
	afterEach(() => {
		for (const child of stray.splice(0)) child.kill("SIGKILL");
		vi.restoreAllMocks();
	});

	it("waits for a real child to report exit before teardown continues", async () => {
		const child = spawnNode("setTimeout(() => {}, 100)");
		await waitForChildExit(child);
		expect(child.exitCode).toBe(0);
	});

	// Recurrence: teardown that hangs forever on a child that never reports
	// exit. A SIGSTOPped real child cannot exit until it is SIGKILLed.
	it("gives up on a child that never exits after the bound, with one diagnostic", async () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const child = spawnNode("setInterval(() => {}, 1000)");
		stray.push(child);
		child.kill("SIGSTOP");
		await waitForChildExit(child, [], 50);
		expect(child.exitCode).toBeNull();
		expect(write.mock.calls.map(([line]) => String(line))).toEqual([
			"[real-pi cleanup] child tree did not exit within 50ms\n",
		]);
	}, 15_000);

	// Recurrence (#4081): pi exits but its reparented grandchild keeps writing
	// under the scratch home; the wait must cover pids beyond the direct child.
	it("also waits for the listed descendants, and gives up on one that stays", async () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const done = spawnNode("");
		const lingering = spawnNode("setInterval(() => {}, 1000)");
		stray.push(lingering);
		await exited(done);
		await waitForChildExit(done, [lingering.pid as number], 50);
		expect(write).toHaveBeenCalledTimes(1);
		lingering.kill("SIGKILL");
		await exited(lingering);
		await waitForChildExit(done, [lingering.pid as number], 50);
		expect(write).toHaveBeenCalledTimes(1);
	}, 15_000);

	// Recurrence (#4081): withRealPi's close() killed only the direct child. The
	// real pi's grandchildren are detached (their own process group), outlive
	// it, and keep writing under the scratch home, so the recursive removal
	// threw ENOTEMPTY. This drives the real pi with an extra extension that
	// spawns exactly that shape, and asserts on what close() leaves behind.
	it.skipIf(process.platform === "win32")(
		"close() kills pi and its detached descendants and removes the home they write into",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment(
				"pi-lens-orphan-writer-",
			);
			const info = path.join(tmpDir, "info.json");
			const extension = path.join(tmpDir, "orphan-writer.mjs");
			writeFileSync(
				extension,
				`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
export default function () {
  const writer = spawn(process.execPath, ["-e", ${JSON.stringify(ORPHAN_WRITER)}, process.env.HOME + "/orphan"], { detached: true, stdio: "ignore" });
  writer.unref();
  writeFileSync(process.env.ORPHAN_WRITER_INFO, JSON.stringify({ pi: process.pid, writer: writer.pid, home: process.env.HOME }));
}
`,
			);
			let pi = 0;
			let writer = 0;
			let home = "";
			try {
				await withRealPi(
					{
						fixture: "scenario-1",
						script: "script.json",
						args: ["-e", extension],
						env: { ORPHAN_WRITER_INFO: info },
					},
					async () => {
						({ pi, writer, home } = JSON.parse(readFileSync(info, "utf8")) as {
							pi: number;
							writer: number;
							home: string;
						});
						expect(isProcessAlive(writer)).toBe(true);
					},
				);
				// close() has returned: the child is reaped (only the exit event
				// reaps it), the detached writer is gone, and its home is removed.
				expect(() => process.kill(pi, 0)).toThrow(/ESRCH/);
				expect(isProcessAlive(writer)).toBe(false);
				expect(existsSync(home)).toBe(false);
			} finally {
				cleanup();
			}
		},
		60_000,
	);

	// PATH is emptied so the child can start only through the harness's own
	// PATH head (#3742); a bare `pi` lookup would exit before the kill.
	it("rejects a governed wait immediately when pi is killed", async () => {
		await withRealPi(
			{ fixture: "scenario-1", script: "script.json", env: { PATH: "" } },
			async (pi) => {
				await pi.prompt("start a turn");
				const started = Date.now();
				const pending = pi.awaitToolResult("never-produced");
				pi.killChildForTest();
				await expect(pending).rejects.toMatchObject({
					name: "RealPiChildExitError",
					signal: "SIGKILL",
				});
				expect(Date.now() - started).toBeLessThan(2_000);
			},
		);
	}, 60_000);
});

describe("removeTempDirSync under a live writer", () => {
	const stray: ChildProcess[] = [];
	afterEach(() => {
		for (const child of stray.splice(0)) child.kill("SIGKILL");
		vi.restoreAllMocks();
	});
	async function startWriter(dir: string, ms: number): Promise<void> {
		const child = spawnNode(WRITER, dir, String(ms));
		stray.push(child);
		await new Promise((resolve) => child.stdout?.once("data", resolve));
	}

	// Recurrence (#4081): one rmSync call (Node 22's in-call maxRetries stalls
	// ~3 s and still throws ENOTEMPTY) leaves the directory behind while a
	// writer is still adding files; fresh calls re-walk it and succeed once the
	// writer is done.
	it("removes a directory a live writer stops writing to partway through", async () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-rm-writer-");
		await startWriter(tmpDir, 400);
		removeTempDirSync(tmpDir);
		expect(existsSync(tmpDir)).toBe(false);
		expect(write).not.toHaveBeenCalled();
		cleanup();
	}, 15_000);

	// Recurrence: a teardown that blocks the worker for as long as a writer
	// lives. The writer outlives the 2 s budget; removal gives up with one
	// diagnostic and never throws into the test.
	it("gives up with one diagnostic when the writer outlives the budget", async () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-rm-writer-");
		await startWriter(tmpDir, 8_000);
		expect(() => removeTempDirSync(tmpDir)).not.toThrow();
		expect(write).toHaveBeenCalledTimes(1);
		expect(String(write.mock.calls[0]?.[0])).toContain(
			"[test cleanup] could not remove temp dir",
		);
		for (const child of stray.splice(0)) child.kill("SIGKILL");
		cleanup();
	}, 15_000);
});
