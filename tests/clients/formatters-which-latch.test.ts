/**
 * #1495 — `which()` in formatters.ts is a spawn on a 5 s budget, and around a
 * dozen `detect*` implementations gate on it. A transient timeout dropped the
 * formatter AND wrote the resulting empty enabled-list into `detectionCache`, a
 * cache invalidated only by a formatter-config file's mtime or size. One stalled
 * `which rustfmt` therefore disabled Rust formatting for the rest of the session
 * unless the user happened to edit a config file.
 *
 * `.rs` is the vehicle: its policy makes rustfmt the smart default, rustfmt is
 * not auto-installable, so selection runs `detect()` and `detect()` runs
 * `which("rustfmt")`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.ts";

const { safeSpawnAsync, logLatencySpy } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	logLatencySpy: vi.fn(),
}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	getAmbientAbortSignal: () => undefined,
	isCommandAvailableAsync: async () => false,
}));
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

import {
	clearFormatterCache,
	getFormattersForFile,
} from "../../clients/formatters.js";

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

/** `which`/`where` ran and found nothing: a genuine absence. */
const notFoundResult = { stdout: "", stderr: "", status: 1 };
const foundResult = (binary: string) => ({
	stdout: `/usr/bin/${binary}\n`,
	stderr: "",
	status: 0,
});

const finder = () => (process.platform === "win32" ? "where" : "which");

const whichCalls = (command: string) =>
	safeSpawnAsync.mock.calls.filter(
		(call) => call[0] === finder() && (call[1] as string[])[0] === command,
	);

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");

function rustFile(): { cwd: string; filePath: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-which-latch-"));
	const filePath = path.join(cwd, "lib.rs");
	fs.writeFileSync(filePath, "fn main() {}\n");
	return { cwd, filePath };
}

const names = async (cwd: string, filePath: string): Promise<string[]> =>
	(await getFormattersForFile(filePath, cwd)).map((f) => f.name);

beforeEach(() => {
	safeSpawnAsync.mockReset();
	logLatencySpy.mockReset();
	clearFormatterCache();
	vi.useFakeTimers({ toFake: ["Date"] });
	return () => vi.useRealTimers();
});

describe("formatter PATH probes (#1495)", () => {
	it("does not cache an empty result caused by a stalled which", async () => {
		const { cwd, filePath } = rustFile();
		safeSpawnAsync.mockImplementation(async () => timeoutResult);

		expect(await names(cwd, filePath)).toEqual([]);
		expect(whichCalls("rustfmt")).toHaveLength(1);

		// Inside the cooldown the transient verdict is reused: no probe storm, and
		// still no cache entry to unstick later.
		expect(await names(cwd, filePath)).toEqual([]);
		expect(whichCalls("rustfmt")).toHaveLength(1);

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		safeSpawnAsync.mockImplementation(async () => foundResult("rustfmt"));
		expect(await names(cwd, filePath)).toEqual(["rustfmt"]);
	});

	it("records the timeout as a probe timeout, not a missing install", async () => {
		const { cwd, filePath } = rustFile();
		safeSpawnAsync.mockImplementation(async () => timeoutResult);
		await names(cwd, filePath);

		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "rustfmt",
			verdict: "unavailable",
			outcome: "transient",
			cause: "probe-timeout",
			latched: false,
			retryAfterMs: TRANSIENT_BASE_COOLDOWN_MS,
		});
	});

	it("latches a genuine absence and stops probing for it", async () => {
		const { cwd, filePath } = rustFile();
		safeSpawnAsync.mockImplementation(async () => notFoundResult);

		expect(await names(cwd, filePath)).toEqual([]);
		expect(whichCalls("rustfmt")).toHaveLength(1);
		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "rustfmt",
			outcome: "missing",
			cause: "not-found",
			latched: true,
		});

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS * 4));
		expect(await names(cwd, filePath)).toEqual([]);
		expect(whichCalls("rustfmt")).toHaveLength(1);
	});

	it("caches a positive detection instead of re-probing PATH every save", async () => {
		const { cwd, filePath } = rustFile();
		safeSpawnAsync.mockImplementation(async () => foundResult("rustfmt"));

		expect(await names(cwd, filePath)).toEqual(["rustfmt"]);
		expect(await names(cwd, filePath)).toEqual(["rustfmt"]);
		expect(whichCalls("rustfmt")).toHaveLength(1);
	});
});
