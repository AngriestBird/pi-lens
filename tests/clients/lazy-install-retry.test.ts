/**
 * #1537 — the lazy-install attempt latch was set BEFORE the install ran and
 * never cleared, so a `gem install rubocop` or `rustup component add` that died
 * on a network blip was never retried for the rest of the session.
 *
 * The guard itself is right: an install storm is worse than a missed install.
 * What was wrong is that a transient failure and a genuine refusal were recorded
 * identically, with no expiry on either. The latch now keys off the attempt's
 * OUTCOME, using #1534's `InstallAttemptFact` vocabulary.
 *
 * Both entry points are covered, because this was a two-copy shape and a fix in
 * one is not a fix: `lazy-installer.ts`'s `tryLazyInstall` (runners) and
 * `formatters.ts`'s `tryLazyInstallFormatterTool`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { describeInstallAttempt } from "../../clients/dispatch/runners/utils/availability-policy.js";
import {
	LAZY_INSTALL_BASE_COOLDOWN_MS,
	LAZY_INSTALL_MAX_COOLDOWN_MS,
	LAZY_INSTALL_MAX_TRANSIENT_ATTEMPTS,
	getLazyInstallAttempt,
	lazyInstallRetryDelayMs,
	resetLazyInstallAttempts,
	tryLazyInstall,
} from "../../clients/dispatch/runners/utils/lazy-installer.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

const okResult = { stdout: "", stderr: "", status: 0 };

/** The install ran and exited nonzero — the retry candidate. */
const failedResult = {
	stdout: "",
	stderr: "Could not find a valid gem 'rubocop' (network is unreachable)",
	status: 1,
};

/** The install was killed by its own budget. Unambiguously transient. */
const timedOutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 180000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

/**
 * The package MANAGER is not on this machine. Durable: no `gem`, no gem
 * install, not this session and not after any cooldown.
 */
const managerMissingResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn gem ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

let cwdSeq = 0;
const freshCwd = () => `/proj/lazy-install-${cwdSeq++}`;

beforeEach(() => {
	safeSpawnAsync.mockReset();
	resetLazyInstallAttempts();
	setProjectTrustState("trusted");
	vi.useFakeTimers({ toFake: ["Date"] });
	return () => {
		vi.useRealTimers();
		resetProjectTrust();
	};
});

describe("a transient lazy-install failure is retried (#1537)", () => {
	it("retries the runner seam after the cooldown", async () => {
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(timedOutResult);

		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		advance(LAZY_INSTALL_BASE_COOLDOWN_MS + 1);
		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
	});

	it("retries the formatter seam after the cooldown", async () => {
		// The second copy of the shape. A fix in one is not a fix.
		const { tryLazyInstallFormatterTool } = await import(
			"../../clients/formatters.js"
		);
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(failedResult);

		expect(await tryLazyInstallFormatterTool("rubocop", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		advance(LAZY_INSTALL_BASE_COOLDOWN_MS + 1);
		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstallFormatterTool("rubocop", cwd)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
	});

	it("holds the storm guard inside the cooldown window", async () => {
		// The caller's cadence is per-save, and #1539 made a degraded formatter
		// selection re-detect every pass — so an unbounded retry here would be a
		// 180 s install per save. Many calls inside the window: exactly one spawn.
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(timedOutResult);

		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		for (let i = 0; i < 5; i++) {
			advance(LAZY_INSTALL_BASE_COOLDOWN_MS / 10);
			expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		}
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("escalates the cooldown and then holds for the session", async () => {
		// Bounded, not indefinite (#1497's lesson): three ≤180 s installs, then
		// the verdict is terminal until a session reset or a success.
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(timedOutResult);

		for (let attempt = 1; attempt <= LAZY_INSTALL_MAX_TRANSIENT_ATTEMPTS; attempt++) {
			expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
			advance(lazyInstallRetryDelayMs(attempt) + 1);
		}
		expect(safeSpawnAsync).toHaveBeenCalledTimes(
			LAZY_INSTALL_MAX_TRANSIENT_ATTEMPTS,
		);

		// Past every cooldown the ladder could produce: still held.
		advance(LAZY_INSTALL_BASE_COOLDOWN_MS * 1000);
		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(
			LAZY_INSTALL_MAX_TRANSIENT_ATTEMPTS,
		);
	});
});

describe("the retry ladder respects the caller's cadence (#1537)", () => {
	it("starts far above a save interval and caps", () => {
		// The cooldown-vs-cadence screen. These installs are up to 3 minutes and
		// both entry points are reached per save, so a probe-sized 30 s base would
		// make the guard decorative.
		expect(lazyInstallRetryDelayMs(1)).toBe(LAZY_INSTALL_BASE_COOLDOWN_MS);
		expect(lazyInstallRetryDelayMs(2)).toBe(LAZY_INSTALL_BASE_COOLDOWN_MS * 2);
		expect(lazyInstallRetryDelayMs(50)).toBe(LAZY_INSTALL_MAX_COOLDOWN_MS);
		expect(LAZY_INSTALL_BASE_COOLDOWN_MS).toBeGreaterThan(60_000);
	});
});

describe("a durable lazy-install failure keeps its session-long hold (#1537)", () => {
	it("does not retry when the package manager itself is absent", async () => {
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(managerMissingResult);

		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// No cooldown expiry rescues this: there is no `gem` to run.
		advance(LAZY_INSTALL_BASE_COOLDOWN_MS * 100);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("still dedupes after a success", async () => {
		// Control: the original guard's whole purpose. Must hold before and after.
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(okResult);

		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(true);
		advance(LAZY_INSTALL_BASE_COOLDOWN_MS * 100);
		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});

describe("lazy-install state re-arms and is readable (#1537)", () => {
	it("re-arms on a session reset", async () => {
		// A suppression that outlives the session is the #1494 permanent-latch
		// shape. The runner copy had no reset at all before this.
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(managerMissingResult);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);

		resetLazyInstallAttempts();
		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
	});

	it("clearing formatter runtime state re-arms the shared seam", async () => {
		const { clearFormatterRuntimeState, tryLazyInstallFormatterTool } =
			await import("../../clients/formatters.js");
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(failedResult);
		expect(await tryLazyInstallFormatterTool("rustfmt", cwd)).toBe(false);

		clearFormatterRuntimeState();
		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstallFormatterTool("rustfmt", cwd)).toBe(true);
	});

	it("reports the attempt in #1534's vocabulary, for install evidence", async () => {
		// Nothing distinguished "we tried once and the network failed" from "this
		// tool cannot be installed here". `describeInstallAttempt` is the seam that
		// turns it into the `availability_decision` record's install evidence.
		const cwd = freshCwd();
		expect(getLazyInstallAttempt("rubocop", cwd)).toBeUndefined();
		expect(describeInstallAttempt(getLazyInstallAttempt("rubocop", cwd))).toEqual(
			{ install: "not-attempted" },
		);

		safeSpawnAsync.mockResolvedValue(failedResult);
		await tryLazyInstall("rubocop", cwd);
		const attempt = getLazyInstallAttempt("rubocop", cwd);
		expect(attempt?.outcome).toBe("failed");
		expect(describeInstallAttempt(attempt)).toMatchObject({ install: "failed" });
		expect(describeInstallAttempt(attempt).installReason).toContain(
			"network is unreachable",
		);

		safeSpawnAsync.mockResolvedValue(okResult);
		advance(LAZY_INSTALL_BASE_COOLDOWN_MS + 1);
		await tryLazyInstall("rubocop", cwd);
		expect(getLazyInstallAttempt("rubocop", cwd)?.outcome).toBe("succeeded");
	});

	it("does not record a trust denial, so a later grant retries", async () => {
		// #1350's invariant, restated against the new record: the trust gate is
		// re-evaluated per call and must never latch. `declined` is not written.
		const cwd = freshCwd();
		setProjectTrustState("untrusted");
		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(getLazyInstallAttempt("rust-clippy", cwd)).toBeUndefined();

		setProjectTrustState("trusted");
		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(true);
	});
});
