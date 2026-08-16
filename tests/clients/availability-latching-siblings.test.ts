/**
 * #1476 — the three availability consumers the #1467 class sweep missed, plus
 * the shared ast-grep memo the #1476 sweep found: biome, `SgRunner`,
 * `isSgAvailableAsync`, and govulncheck's `go install`.
 *
 * Each one latched ANY probe failure — a timeout included — as a permanent
 * "the tool is not installed" verdict, and biome and `SgRunner` ran a full
 * auto-install on the way there.
 *
 * Every describe block pins the two verdicts that must NOT change (a genuine
 * absence, a successful probe) beside the transient case that must. A migration
 * that quietly redefined "missing" for the hot-path formatter would be worse
 * than the bug it fixes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.ts";

/**
 * Reset through the SAME module instance the clients load (the compiled `.js`),
 * not the `.ts` source: the shared ast-grep memo lives in module state, and a
 * reset applied to a second instance of the module silently resets nothing.
 */
async function resetDispatchAvailabilityState(): Promise<void> {
	const helpers = await import(
		"../../clients/dispatch/runners/utils/runner-helpers.js"
	);
	helpers.resetDispatchAvailabilityState();
}

const { safeSpawnAsync, safeSpawn, ensureTool } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	safeSpawn: vi.fn(),
	ensureTool: vi.fn(),
}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
	isCommandAvailableAsync: vi.fn(async () => false),
}));

vi.mock("../../clients/installer/index.js", () => ({
	ensureTool,
	isSpawnableCommand: vi.fn(async () => true),
	resetPathWalkMemo: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({})),
}));

vi.mock("../../clients/package-manager.js", () => ({
	findGlobalBinary: vi.fn(async () => undefined),
	findNodeToolBinary: vi.fn(async () => undefined),
}));

vi.mock("../../clients/project-trust.js", () => ({
	assertInstallAllowed: vi.fn(() => true),
}));

/** A probe the host killed at its budget: says nothing about the tool. */
const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

/** A probe that proved the tool is not on this machine. */
const missingResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const okResult = (stdout: string) => ({
	stdout,
	stderr: "",
	status: 0,
	error: undefined,
});

function advancePastCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
}

beforeEach(async () => {
	vi.resetAllMocks();
	ensureTool.mockResolvedValue(null);
	safeSpawn.mockReturnValue({ stdout: "", stderr: "", status: 1 });
	await resetDispatchAvailabilityState();
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
	vi.useRealTimers();
	await resetDispatchAvailabilityState();
});

describe("BiomeClient availability (#1476)", () => {
	it("pins a genuine absence: latched false, and an install IS attempted", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();

		expect(await client.ensureAvailable()).toBe(false);
		expect(ensureTool).toHaveBeenCalledWith("biome");
		const probesAfterFirst = safeSpawnAsync.mock.calls.length;

		// A durable verdict is remembered for the session: no second probe.
		expect(await client.ensureAvailable()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probesAfterFirst);
	});

	it("pins a successful probe: available, and no install", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("biome 1.9.4"));
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();

		expect(await client.ensureAvailable()).toBe(true);
		expect(ensureTool).not.toHaveBeenCalled();
	});

	it("a timed-out probe neither installs nor latches, and recovers", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();

		expect(await client.ensureAvailable()).toBe(false);
		// Pre-fix, the timeout collapsed to `missing`, which installed biome.
		expect(ensureTool).not.toHaveBeenCalled();

		// Inside the cooldown the verdict holds, so a stalling host cannot be
		// re-probed on every keystroke.
		const probes = safeSpawnAsync.mock.calls.length;
		expect(await client.ensureAvailable()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);

		// After the cooldown the very same client re-probes and biome comes back
		// without a host restart. Pre-fix this stayed false forever.
		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("biome 1.9.4"));
		expect(await client.ensureAvailable()).toBe(true);
	});

	it("concurrent first-time callers share one probe (no retry storm)", async () => {
		let release: ((value: unknown) => void) | undefined;
		safeSpawnAsync.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();
		const calls = [
			client.ensureAvailable(),
			client.ensureAvailable(),
			client.ensureAvailable(),
		];
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		release?.(okResult("biome 1.9.4"));
		expect(await Promise.all(calls)).toEqual([true, true, true]);
	});
});

describe("SgRunner availability (#1476)", () => {
	it("pins a genuine absence: latched false, and an install IS attempted", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);
		const { SgRunner } = await import("../../clients/sg-runner.js");
		const runner = new SgRunner();

		expect(await runner.ensureAvailable()).toBe(false);
		expect(ensureTool).toHaveBeenCalledWith("ast-grep");
		const probes = safeSpawnAsync.mock.calls.length;
		expect(await runner.ensureAvailable()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);
	});

	it("pins a successful probe: available, and no install", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("ast-grep 0.32.3"));
		const { SgRunner } = await import("../../clients/sg-runner.js");
		const runner = new SgRunner();

		expect(await runner.ensureAvailable()).toBe(true);
		expect(ensureTool).not.toHaveBeenCalled();
	});

	it("a timed-out sweep neither installs nor latches, and recovers", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { SgRunner } = await import("../../clients/sg-runner.js");
		const runner = new SgRunner();

		expect(await runner.ensureAvailable()).toBe(false);
		// Pre-fix this ran a full ast-grep auto-install because the host stalled.
		expect(ensureTool).not.toHaveBeenCalled();

		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("ast-grep 0.32.3"));
		expect(await runner.ensureAvailable()).toBe(true);
	});
});

describe("shared ast-grep availability (#1476)", () => {
	it("pins a genuine absence: latched false for the session", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);
		const { isSgAvailableAsync } = await import(
			"../../clients/dispatch/runners/utils/runner-helpers.js"
		);

		expect(await isSgAvailableAsync()).toBe(false);
		const probes = safeSpawnAsync.mock.calls.length;
		expect(probes).toBeGreaterThan(0);
		expect(await isSgAvailableAsync()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);
	});

	it("a timed-out sweep expires and re-probes after the cooldown", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { isSgAvailableAsync } = await import(
			"../../clients/dispatch/runners/utils/runner-helpers.js"
		);

		expect(await isSgAvailableAsync()).toBe(false);
		const probes = safeSpawnAsync.mock.calls.length;
		// Held inside the cooldown: no probe storm while the host is still sick.
		expect(await isSgAvailableAsync()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);

		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("ast-grep 0.32.3"));
		expect(await isSgAvailableAsync()).toBe(true);
	});
});

describe("govulncheck availability (#1476)", () => {
	/** Route each spawn by command so install order stays readable. */
	function route(handlers: {
		govulncheck?: unknown[];
		go?: unknown[];
		install?: unknown;
	}): void {
		const govulncheckQueue = [...(handlers.govulncheck ?? [])];
		const goQueue = [...(handlers.go ?? [])];
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === "govulncheck") {
				return govulncheckQueue.shift() ?? missingResult;
			}
			if (cmd === "go" && args[0] === "install") {
				return handlers.install ?? okResult("");
			}
			return goQueue.shift() ?? okResult("go version go1.23.0");
		});
	}

	it("pins the install path: probe misses, go installs, re-probe succeeds", async () => {
		route({
			govulncheck: [missingResult, okResult("govulncheck v1.1.3")],
			install: okResult(""),
		});
		const { GovulncheckClient } = await import(
			"../../clients/govulncheck-client.js"
		);
		const client = new GovulncheckClient();

		expect(await client.ensureAvailable()).toBe(true);
	});

	it("pins a failed install (non-zero exit): latched false, no re-install", async () => {
		route({
			govulncheck: [missingResult],
			install: { stdout: "", stderr: "no matching versions", status: 1 },
		});
		const { GovulncheckClient } = await import(
			"../../clients/govulncheck-client.js"
		);
		const client = new GovulncheckClient();

		expect(await client.ensureAvailable()).toBe(false);
		const spawns = safeSpawnAsync.mock.calls.length;
		expect(await client.ensureAvailable()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(spawns);
	});

	it("a timed-out `go install` does not latch, and recovers", async () => {
		route({ govulncheck: [missingResult], install: timeoutResult });
		const { GovulncheckClient } = await import(
			"../../clients/govulncheck-client.js"
		);
		const client = new GovulncheckClient();

		expect(await client.ensureAvailable()).toBe(false);

		// Pre-fix, the 60 s network budget expiring once disabled govulncheck for
		// the life of the process.
		advancePastCooldown();
		route({ govulncheck: [okResult("govulncheck v1.1.3")] });
		expect(await client.ensureAvailable()).toBe(true);
	});
});

describe("dispatch hasTool availability (#1476)", () => {
	/** The generic seam every CLI runner gates on: `ctx.hasTool(command)`. */
	async function load() {
		const dispatcher = await import("../../clients/dispatch/dispatcher.js");
		const { FactStore } = await import("../../clients/dispatch/fact-store.js");
		return { checkToolAvailability: dispatcher.checkToolAvailability, facts: new FactStore() };
	}

	it("pins a successful probe: available, and cached for the session", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("1.2.3"));
		const { checkToolAvailability, facts } = await load();

		expect(await checkToolAvailability("sometool", facts)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		expect(await checkToolAvailability("sometool", facts)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("pins a genuine absence: latched false for the session", async () => {
		safeSpawnAsync.mockResolvedValue({
			stdout: "",
			stderr: "",
			status: 1,
			error: undefined,
		});
		const { checkToolAvailability, facts } = await load();

		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("a timed-out probe does not latch, and the tool comes back", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { checkToolAvailability, facts } = await load();

		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		// Held for the cooldown: a stalling host is not re-probed every dispatch.
		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// Pre-fix, this false was a session fact and every later dispatch in the
		// session skipped the tool.
		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("1.2.3"));
		expect(await checkToolAvailability("sometool", facts)).toBe(true);
	});
});
