/**
 * #1494 — `tryEslintFix` memoized its `eslint --version` verdict per cwd+PATH
 * in a bounded LRU with no transient split, so one stalled probe stopped eslint
 * autofix for that project until the entry was evicted or the host restarted.
 * The verdict now belongs to the shared availability latch: only a genuine
 * absence sticks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.ts";

const { safeSpawnAsync, logLatencySpy } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	logLatencySpy: vi.fn(),
}));
vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

import { runAutofix } from "../../clients/pipeline.js";

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

describe("eslint autofix availability latch (#1494)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let filePath: string;

	beforeEach(() => {
		safeSpawnAsync.mockReset();
		logLatencySpy.mockReset();
		env = setupTestEnvironment("pi-lens-eslint-latch-");
		fs.writeFileSync(path.join(env.tmpDir, ".eslintrc.json"), "{}\n");
		filePath = path.join(env.tmpDir, "messy.js");
		fs.writeFileSync(filePath, "const x = 1\nconsole.log(x)\n");
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		env.cleanup();
	});

	function deps() {
		return {
			biomeClient: {
				isSupportedFile: () => false,
				ensureAvailable: async () => false,
			},
			ruffClient: {
				isPythonFile: () => false,
				ensureAvailable: async () => false,
			},
			fixedThisTurn: new Set<string>(),
		};
	}

	const fix = () =>
		runAutofix(filePath, env.tmpDir, () => undefined, () => {}, deps() as never);

	const versionCalls = () =>
		safeSpawnAsync.mock.calls.filter((call) =>
			(call[1] as string[] | undefined)?.includes("--version"),
		).length;

	it("re-probes after a timed-out probe and fixes on the next turn", async () => {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.includes("--version")
				? timeoutResult
				: { error: null, status: 0, stdout: "", stderr: "" },
		);

		expect((await fix()).fixedCount).toBe(0);
		expect(versionCalls()).toBe(1);
		// Inside the cooldown the verdict is reused rather than re-probed.
		expect((await fix()).fixedCount).toBe(0);
		expect(versionCalls()).toBe(1);

		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		safeSpawnAsync.mockClear();
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args.includes("--version")) {
				return { error: null, status: 0, stdout: "v10.5.0", stderr: "" };
			}
			fs.writeFileSync(filePath, "const x = 1;\nconsole.log(x);\n");
			return { error: null, status: 0, stdout: "", stderr: "" };
		});

		expect((await fix()).fixedCount).toBeGreaterThan(0);
		expect(versionCalls()).toBe(1);
		// The record says the first verdict was a timeout, not a missing install.
		expect(
			logLatencySpy.mock.calls
				.map((call) => call[0])
				.find((entry) => entry?.phase === "availability_decision")?.metadata,
		).toMatchObject({ tool: "eslint", outcome: "transient", latched: false });
	});

	it("latches a genuinely missing eslint and stops probing", async () => {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.includes("--version")
				? {
						stdout: "",
						stderr: "",
						status: null,
						error: Object.assign(new Error("spawn ENOENT"), {
							code: "ENOENT",
						}),
						spawnFailure: { kind: "tool-not-found" },
					}
				: { error: null, status: 0, stdout: "", stderr: "" },
		);

		expect((await fix()).fixedCount).toBe(0);
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS * 4));
		expect((await fix()).fixedCount).toBe(0);
		expect(versionCalls()).toBe(1);
	});
});
