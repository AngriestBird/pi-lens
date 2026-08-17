/**
 * #1500 — a transient failure classified as durable INSIDE an already-governed
 * latch.
 *
 * Migrating a memo to the shared policy makes its storage correct and says
 * nothing about its classification. A call site can hand the latch
 * `("missing", "not-found")` for something that was really transient, and the
 * resulting row is a well-formed `missing` verdict: indistinguishable from a
 * genuine absence. The class is deliberately ungated, so the fix is auditability
 * — every decision record says HOW it was classified and carries the raw facts
 * it was derived from.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyProbeFailure,
	describeProbeEvidence,
} from "../../clients/dispatch/runners/utils/availability-policy.ts";

const { safeSpawnAsync, logLatencySpy, ensureTool } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	logLatencySpy: vi.fn(),
	ensureTool: vi.fn(),
}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
}));
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));
vi.mock("../../clients/installer/index.js", () => ({
	ensureTool,
	isSpawnableCommand: async () => true,
	resetPathWalkMemo: () => {},
	getToolEnvironment: async () => ({ ...process.env }),
}));
vi.mock("../../clients/sessionstart-logger.js", () => ({
	logSessionStart: vi.fn(),
}));

import { SecurityScanClient } from "../../clients/security-scan-client.js";
import {
	createAvailabilityChecker,
	resetDispatchAvailabilityState,
} from "../../clients/dispatch/runners/utils/runner-helpers.js";

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

const notFoundResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn faketool ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision")
		.map((entry) => entry.metadata);

class FakeScanClient extends SecurityScanClient<string[]> {
	constructor() {
		super("faketool");
	}
	protected doEnsureAvailable(): Promise<boolean> {
		return this.ensureViaInstaller(["--version"]);
	}
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	logLatencySpy.mockReset();
	ensureTool.mockReset();
	resetDispatchAvailabilityState();
});

describe("probe evidence (#1500)", () => {
	it("reads the facts off a spawn result and omits what it does not carry", () => {
		expect(describeProbeEvidence(notFoundResult)).toEqual({
			status: null,
			failure: "spawn",
			spawnFailureKind: "tool-not-found",
			errno: "ENOENT",
		});
		// A plain nonzero exit carries a status and nothing else.
		expect(describeProbeEvidence({ status: 1 })).toEqual({ status: 1 });
	});

	it("comes back from classifyProbeFailure beside the verdict it produced", () => {
		const classified = classifyProbeFailure(timeoutResult);
		expect(classified.outcome).toBe("transient");
		expect(classified.evidence).toMatchObject({
			failure: "timeout",
			spawnFailureKind: "timeout",
		});
	});
});

describe("decision records say how they were classified (#1500)", () => {
	it("marks a derived verdict as probe-classified and shows the evidence", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-evidence-"));
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const checker = createAvailabilityChecker("faketool");

		expect(await checker.isAvailableAsync(cwd)).toBe(false);
		expect(decisions()[0]).toMatchObject({
			tool: "faketool",
			outcome: "transient",
			cause: "probe-timeout",
			classifiedBy: "probe",
			evidence: { failure: "timeout", spawnFailureKind: "timeout" },
		});
	});

	it("marks a stat-derived bad-cwd verdict as caller-asserted", async () => {
		safeSpawnAsync.mockResolvedValue(notFoundResult);
		const checker = createAvailabilityChecker("faketool");

		expect(
			await checker.isAvailableAsync(
				path.join(os.tmpdir(), "pi-lens-does-not-exist-1500"),
			),
		).toBe(false);
		expect(decisions()[0]).toMatchObject({
			cause: "bad-cwd",
			classifiedBy: "caller",
		});
		// The workspace is gone; nothing here is evidence about the tool.
		expect(decisions()[0]?.evidence).toBeUndefined();
	});
});

describe("a failed install is a recorded assertion, not a silent latch (#1500)", () => {
	it("records the install failure beside the missing verdict", async () => {
		safeSpawnAsync.mockResolvedValue(notFoundResult);
		ensureTool.mockResolvedValue(null);
		const client = new FakeScanClient();

		expect(await client.ensureAvailable()).toBe(false);
		expect(ensureTool).toHaveBeenCalledWith("faketool");

		// Two rows: the probe that found nothing, then the assertion that followed
		// the failed repair. Before #1500 the second one did not exist at all.
		expect(decisions()).toHaveLength(2);
		expect(decisions()[0]).toMatchObject({
			outcome: "missing",
			cause: "not-found",
			classifiedBy: "probe",
			evidence: { errno: "ENOENT", spawnFailureKind: "tool-not-found" },
		});
		expect(decisions()[1]).toMatchObject({
			outcome: "missing",
			cause: "not-found",
			latched: true,
			classifiedBy: "caller",
			evidence: { install: "failed" },
		});
	});

	it("still refuses to install — or latch — on a timed-out probe", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const client = new FakeScanClient();

		expect(await client.ensureAvailable()).toBe(false);
		expect(ensureTool).not.toHaveBeenCalled();
		expect(decisions()).toHaveLength(1);
		expect(decisions()[0]).toMatchObject({
			outcome: "transient",
			classifiedBy: "probe",
			latched: false,
		});
	});
});
