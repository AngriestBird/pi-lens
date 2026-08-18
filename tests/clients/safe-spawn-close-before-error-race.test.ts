/**
 * #1651 — the lifecycle-smoke lane's phase 5 pinned outcome "missing" for a
 * genuinely-absent `gh` binary, and passed on Windows but got "non-installable"
 * on Linux CI. Root cause: Node's own docs say the 'error' and 'close' event
 * ORDER for a child that never started (ENOENT) is unspecified — "the 'exit'
 * event may or may not fire after an error has occurred" — and some
 * platforms/loads fire 'close' BEFORE 'error'.
 *
 * `safeSpawnAsync`'s `close` handler only guarded against 'close' firing
 * AFTER 'error' (`if (spawnErrored) return;`). When 'close' won the race with
 * `code: null, signal: null` — the shape Node emits for a spawn that never
 * launched, since a process that actually RAN always exits with a numeric
 * code or a signal — the handler fell through to the "clean run" branch and
 * resolved `{ status: null, error: undefined }`: a would-be `tool-not-found`
 * (`missing`) misread as a completed, successful probe. Downstream,
 * `classifyGhTokenFailure`'s `!res.error` branch then reads that as a durable
 * `non-installable` rejection instead of `missing`.
 *
 * Windows rarely hits this: `resolveWindowsCommand` fails closed on an
 * unresolvable bare command BEFORE any real `spawn()` call, synthesizing a
 * clean ENOENT deterministically. Linux (and any Windows command that DOES
 * resolve, e.g. an absolute path whose target is later removed) goes through
 * the raw event race every time — this test mocks `spawn()` directly so it
 * reproduces the race regardless of which platform runs the suite.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const enoentError = Object.assign(new Error("spawn gh ENOENT"), {
	code: "ENOENT",
	syscall: "spawn gh",
	path: "gh",
});

interface FakeChild extends EventEmitter {
	stdout?: EventEmitter;
	stderr?: EventEmitter;
	pid?: number;
	killed?: boolean;
	kill: (...args: unknown[]) => boolean;
}

function makeFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.kill = () => true;
	child.killed = false;
	return child;
}

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
	// Harmless no-op: the Windows chcp one-shot and taskkill paths call this.
	spawnSync: () => ({ stdout: "", stderr: "", status: 0, error: undefined }),
}));

vi.mock("../../clients/resource-sampler.js", () => ({
	startSpawnUsageSampler: () => ({ stop: () => null }),
}));

vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: () => {},
}));

const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");

describe("safeSpawnAsync survives 'close' winning the race against 'error' (#1651)", () => {
	it("still classifies as tool-not-found when 'close' fires before 'error'", async () => {
		const child = makeFakeChild();
		spawnMock.mockImplementation(() => {
			// Simulate the platform-dependent ordering Node's docs warn about: a
			// process that never started emits `close(null, null)` — a shape no
			// completed run ever produces — before its 'error' event lands.
			queueMicrotask(() => {
				child.emit("close", null, null);
				child.emit("error", enoentError);
			});
			return child;
		});

		// An absolute, real path so Windows command resolution succeeds and this
		// test reaches the mocked `spawn()` on every platform, exactly like a
		// bare `gh` does on Linux (no pre-resolution step at all there).
		const result = await safeSpawnAsync(process.execPath, ["--version"]);

		expect(result.error).toBeInstanceOf(Error);
		expect(result.status).toBeNull();
		expect(result.spawnFailure?.kind).toBe("tool-not-found");
	});
});
