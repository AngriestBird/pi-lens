/**
 * #2042 — the suite's own SIGKILL.
 *
 * `tests/clients/lsp/launch.test.ts` mocked `node:child_process` with a fake
 * child whose pid was the literal `2468`. The PRODUCTION path
 * (`launchLSP` -> `package-manager.isAvailable` -> `probeToolAsync` ->
 * `safeSpawnAsync("which")`) registered that invented pid in the real
 * `lifetimeState.pids`; the fake never emitted `close`, so `finalize()` never
 * removed it, and at fork teardown `installLifetimeCleanup()`'s `exit`
 * handler ran `process.kill(-2468, "SIGKILL")` then
 * `process.kill(2468, "SIGKILL")`. On ~10 % of GitHub runners pid 2468 was
 * one of the job's own long-lived processes: `Killed npm test`, exit 137, no
 * failing assertion, no kernel record — five weeks of "infra kill" reruns.
 *
 * Every case below drives the REAL seam (`safeSpawnAsync`, `killProcessTree`)
 * with a child_process double, never a hand-fed pid list, and the foreign pid
 * is `process.ppid`: a process that provably exists and provably is not our
 * child, so the assertions are deterministic on any Linux host rather than
 * depending on whether an invented number happens to be live.
 *
 * `process.kill` is mocked in every case that could reach it, so a regression
 * here can never deliver a real signal to the runner.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { isOwnLiveChild } from "../../clients/safe-spawn.js";

/** The registry `clients/safe-spawn.ts` shares across module instances. */
const LIFETIME_STATE_KEY = Symbol.for("pi-lens.safe-spawn.lifetime-state");

function lifetimePids(): Set<number> {
	const host = process as typeof process & {
		[LIFETIME_STATE_KEY]?: { pids: Set<number>; installed: boolean };
	};
	return host[LIFETIME_STATE_KEY]?.pids ?? new Set<number>();
}

class FakeStream extends EventEmitter {
	write() {
		return true;
	}
	end() {}
	setEncoding() {}
}

/** A child_process double that never terminates — exactly the #2042 fake. */
class FakeChild extends EventEmitter {
	stdin = new FakeStream();
	stdout = new FakeStream();
	stderr = new FakeStream();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
	unref() {}
	constructor(public pid: number) {
		super();
	}
}

const posixOnly = it.skipIf(process.platform !== "linux");

describe("kill-by-pid ownership (#2042)", () => {
	let exitListenersBefore: ReadonlyArray<unknown> = [];

	beforeEach(() => {
		resetDegradationLedger();
		exitListenersBefore = process.listeners("exit");
	});

	afterEach(() => {
		// Remove anything production installed during the case, so a leaked
		// exit handler cannot fire against a later file's state.
		for (const listener of process.listeners("exit")) {
			if (!exitListenersBefore.includes(listener))
				process.off("exit", listener as () => void);
		}
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock("node:child_process");
	});

	/**
	 * The handle arm, which is all the ownership evidence Windows has (there
	 * is no `/proc` to read): `lsp/launch.ts#killWindowsTree` folded its
	 * already-exited check into this predicate, and a dead pid may have been
	 * recycled to an unrelated process that `taskkill /F /T` would destroy.
	 * Runs on every lane — the arm is platform-independent by construction.
	 */
	it("refuses a pid whose handle has already reported exit", () => {
		expect(isOwnLiveChild(process.ppid, "test", { exitCode: 0 })).toBe(false);
		expect(
			isOwnLiveChild(process.ppid, "test", { signalCode: "SIGTERM" }),
		).toBe(false);
		expect(isOwnLiveChild(0, "test")).toBe(false);
		expect(isOwnLiveChild(-1, "test")).toBe(false);
		expect(isOwnLiveChild(undefined, "test")).toBe(false);
	});

	posixOnly(
		"refuses a live pid belonging to another parent, and records it once per site",
		() => {
			expect(isOwnLiveChild(process.ppid, "test-site")).toBe(false);
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "kill-foreign-pid-refused",
			);
			expect(group?.latestReasons.map((entry) => entry.subject)).toEqual([
				"test-site",
			]);
			expect(group?.latestReasons[0]?.reason).toContain(
				`pid ${process.ppid} has parent`,
			);
			// Bounded: the subject is the SITE, so a second refusal of a
			// different pid raises the count and never the entry list.
			isOwnLiveChild(process.ppid, "test-site");
			const after = getDegradationSummary().find(
				(entry) => entry.kind === "kill-foreign-pid-refused",
			);
			expect(after?.count).toBe(2);
			expect(after?.latestReasons).toHaveLength(1);
		},
	);

	posixOnly(
		"a fabricated child pid never enters the lifetime registry, so host exit never signals it",
		async () => {
			const foreignPid = process.ppid;
			const child = new FakeChild(foreignPid);
			vi.doMock("node:child_process", () => ({
				spawn: vi.fn(() => child),
				spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
				execSync: vi.fn(() => ""),
				execFileSync: vi.fn(() => ""),
			}));
			const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");

			const pending = safeSpawnAsync("which", ["node"], { timeout: 50_000 });
			await vi.waitFor(() =>
				expect(child.listenerCount("close")).toBeGreaterThan(0),
			);

			expect([...lifetimePids()]).not.toContain(foreignPid);

			// Fire whatever exit handlers production installed during the call —
			// the seam that shipped `process.kill(-2468, "SIGKILL")`.
			const killSpy = vi
				.spyOn(process, "kill")
				.mockImplementation(() => true as never);
			for (const listener of process.listeners("exit")) {
				if (!exitListenersBefore.includes(listener))
					(listener as (code: number) => void)(0);
			}
			expect(killSpy).not.toHaveBeenCalled();

			child.emit("close", 0, null);
			await pending;
		},
	);

	posixOnly(
		"a timeout kill on a fabricated child pid signals the handle, never the process group",
		async () => {
			const foreignPid = process.ppid;
			const child = new FakeChild(foreignPid);
			vi.doMock("node:child_process", () => ({
				spawn: vi.fn(() => child),
				spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
				execSync: vi.fn(() => ""),
				execFileSync: vi.fn(() => ""),
			}));
			const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
			const killSpy = vi
				.spyOn(process, "kill")
				.mockImplementation(() => true as never);

			const pending = safeSpawnAsync("which", ["node"], { timeout: 10 });
			await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());

			expect(killSpy).not.toHaveBeenCalled();
			child.emit("close", null, "SIGTERM");
			await pending;
		},
	);

	posixOnly(
		"stopLSP's POSIX group kill refuses a pid the process does not own",
		async () => {
			const foreignPid = process.ppid;
			const proc = new FakeChild(foreignPid);
			const killSpy = vi
				.spyOn(process, "kill")
				.mockImplementation(() => true as never);
			const { killProcessTree } = await import("../../clients/lsp/client.js");

			await killProcessTree(proc as never, foreignPid, { fast: true });

			expect(killSpy).not.toHaveBeenCalled();
			// The handle-based fallback still runs: an unowned pid must not turn
			// shutdown into a no-op (defect shape 10, silencing as fixing).
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		},
	);
});
