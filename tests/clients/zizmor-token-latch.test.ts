/**
 * #1535 — a stalled `gh auth token` probe used to fold into a memoized
 * `{ value: undefined }` that stuck for the rest of the process (no TTL, no
 * transient split), silently disabling zizmor's GitHub-aware online audits
 * (known-vulnerable-actions, unpinned-uses, impostor-commit) while the scan
 * kept reporting success. The #1467/#1494 permanent-probe-latch class: a
 * spawn-derived verdict memoized in state that outlives the call.
 *
 * These tests pin the fix's three acceptance criteria:
 *  - a timed-out probe is retried after its cooldown, never cached;
 *  - a genuine "not authenticated" answer (gh ran, exit 1) may cache;
 *  - entering offline mode because of a TRANSIENT failure produces a
 *    legible degradation record (#1459's security-silence shape: a
 *    degraded scan must never look identical to a clean one).
 *
 * The timeout/degradation assertions are RED on pre-fix code (the old
 * `cachedGhToken` memo has no cooldown and never calls `recordDegradation`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.ts";

const { safeSpawnAsync, logLatency } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	logLatency: vi.fn(),
}));

// Spread the real module: only `logLatency` is intercepted, so
// availability-policy's `logAvailabilityDecision` (which funnels through it)
// keeps working and its records are observable.
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: (...args: unknown[]) => safeSpawnAsync(...args),
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_resetZizmorTokenCacheForTests,
	resolveZizmorGitHubToken,
} from "../../clients/zizmor-config.js";

/** A probe the host killed at its timeout budget: says nothing about `gh`. */
const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout" as const,
	spawnFailure: { kind: "timeout" },
};

/** A probe that never even launched (e.g. a locked/AV-held binary). */
const unspawnableResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn gh EACCES"), { code: "EACCES" }),
	failure: "spawn" as const,
	spawnFailure: { kind: "permission-denied" },
};

/** `gh` ran to completion and answered "not authenticated". */
const notAuthenticatedResult = {
	stdout: "",
	stderr: "not logged in\n",
	status: 1,
	error: undefined,
};

const okResult = (token: string) => ({
	stdout: `${token}\n`,
	stderr: "",
	status: 0,
	error: undefined,
});

/** availability_decision records for the gh-token prober, oldest first. */
function tokenDecisions(): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter(
			(entry) =>
				entry?.phase === "availability_decision" &&
				(entry.metadata as Record<string, unknown> | undefined)?.tool ===
					"zizmor-gh-token",
		);
}

const ENV_KEYS = [
	"ZIZMOR_OFFLINE",
	"ZIZMOR_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
	safeSpawnAsync.mockReset();
	logLatency.mockReset();
	_resetZizmorTokenCacheForTests();
	resetDegradationLedger();
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	vi.useRealTimers();
});

describe("resolveZizmorGitHubToken transient handling (#1535)", () => {
	it("retries a timed-out probe after its cooldown instead of caching undefined forever", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// Still within the cooldown: served from the latch, no re-spawn — the
		// verdict has NOT been forgotten, it's just not re-probed yet.
		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// Past the cooldown, gh is healthy again: the probe must run again and
		// the token must come back. Pre-fix, the old `cachedGhToken` memo never
		// expires, so this second probe never happens and this assertion fails.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		safeSpawnAsync.mockResolvedValue(okResult("gho_recovered"));
		expect(await resolveZizmorGitHubToken()).toBe("gho_recovered");
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
	});

	it("does not latch an unspawnable probe (EACCES/spawn-failed) as durable absence", async () => {
		safeSpawnAsync.mockResolvedValue(unspawnableResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		const records = tokenDecisions();
		expect(records).toHaveLength(1);
		const metadata = records[0].metadata as Record<string, unknown>;
		// The prober never actually ran, so this must NOT read as a genuine
		// "no" — outcome must be transient (latched: false), never `missing`
		// or `non-installable` (both of which latch forever).
		expect(metadata.outcome).toBe("transient");
		expect(metadata.latched).toBe(false);
	});

	it("caches a genuine 'not authenticated' answer (gh ran and answered)", async () => {
		safeSpawnAsync.mockResolvedValue(notAuthenticatedResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// A second call within what would be a transient cooldown must NOT
		// re-probe: gh answered "not authenticated", and that answer is
		// trustworthy — re-deriving it every call would be wasted work.
		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		const records = tokenDecisions();
		expect(records).toHaveLength(1);
		expect(records[0].metadata).toMatchObject({
			outcome: "non-installable",
			cause: "probe-rejected",
			latched: true,
		});
	});

	it("caches a genuine success and never re-derives it", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("gho_derived"));

		expect(await resolveZizmorGitHubToken()).toBe("gho_derived");
		expect(await resolveZizmorGitHubToken()).toBe("gho_derived");
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});

describe("offline-mode degradation observability (#1535, #1459)", () => {
	it("records a legible degradation when a transient probe forces zizmor offline", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();

		const summary = getDegradationSummary();
		const zizmorGroup = summary.find((g) => g.kind === "mode-suppression");
		expect(zizmorGroup).toBeDefined();
		expect(zizmorGroup?.latestReasons.at(-1)?.subject).toBe("zizmor");
		expect(zizmorGroup?.latestReasons.at(-1)?.reason).toMatch(
			/probe-timeout|host-stall/,
		);
	});

	it("does NOT record a degradation for a durable 'not authenticated' answer", async () => {
		safeSpawnAsync.mockResolvedValue(notAuthenticatedResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();

		// A user who genuinely never logged in isn't a degradation — nothing
		// unexpected happened, so nothing should be recorded for it.
		const summary = getDegradationSummary();
		expect(summary.find((g) => g.kind === "mode-suppression")).toBeUndefined();
	});
});
