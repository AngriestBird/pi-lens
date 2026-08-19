/**
 * Periodic refresh of pi-lens's managed npm tools (#1730).
 *
 * `~/.pi-lens/tools/package.json` records `"knip": "^6.4.1"`, which permits
 * 6.32.2, but the lockfile written at first install pinned 6.4.1 and nothing
 * ever re-resolved it. The managed knip produced 62 unused-export findings on a
 * tree its own project's knip reported clean. All 22 managed entries drift the
 * same way.
 *
 * These tests pin the policy, not just the happy path:
 *   - a stale stamp triggers exactly ONE refresh attempt;
 *   - a fresh stamp triggers none;
 *   - a failed refresh degrades once, keeps the installed version serving, and
 *     comes back on the shorter retry cooldown rather than every session;
 *   - the session budget re-arms per session, never per process;
 *   - an UNREADABLE stamp file is not "everything is fresh" and not
 *     "everything is stale" — it refreshes nothing and says so;
 *   - a version that moves emits an old → new row.
 *
 * `safeSpawnAsync` is mocked so spawn ATTEMPTS can be counted exactly; every
 * other seam (the durable-store stamp, the node_modules fixtures, the cadence
 * arithmetic) runs for real against a temp `PI_LENS_HOME`.
 */

import * as fs from "node:fs";

import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.unmock("../../../clients/installer/index.js");

const TEST_HOME = vi.hoisted(() => {
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const dir = nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-1730-"),
	);
	// TOOLS_DIR is a module-level const, so the override must land before the
	// installer module is imported.
	process.env.PI_LENS_HOME = dir;
	return dir;
});

const { spawnMock, sessionLogSpy } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	sessionLogSpy: vi.fn(),
}));

vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: spawnMock,
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

vi.mock("../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: sessionLogSpy,
	flushSessionStartLog: async () => {},
	flushSessionStartLogSync: () => {},
	SESSIONSTART_LOG_FILE: "",
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { getRefreshableManagedNpmTools } from "../../../clients/installer/index.js";
import {
	getManagedToolRefreshStatePath,
	readManagedToolRefreshState,
	runManagedToolRefresh,
} from "../../../clients/installer/managed-tool-refresh.js";
import { resetManagedToolRefreshSession } from "../../../clients/installer/managed-tool-refresh-session.js";

const TOOLS_DIR = path.join(TEST_HOME, "tools");
const NODE_MODULES = path.join(TOOLS_DIR, "node_modules");
const STATE_PATH = getManagedToolRefreshStatePath();
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** Install a fake managed package at `version`, as npm would leave it. */
function installFixture(packageName: string, version: string): void {
	const dir = path.join(NODE_MODULES, packageName);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: packageName, version }),
	);
}

function installedVersion(packageName: string): string | undefined {
	try {
		return JSON.parse(
			fs.readFileSync(
				path.join(NODE_MODULES, packageName, "package.json"),
				"utf-8",
			),
		).version;
	} catch {
		return undefined;
	}
}

function writeState(tools: Record<string, unknown>): void {
	fs.mkdirSync(TOOLS_DIR, { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify({ version: 1, tools }, null, 2));
}

function readState(): Record<
	string,
	{ checkedAt: number; version?: string; failed?: boolean }
> {
	return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")).tools;
}

/** Spawn calls that are an actual package-manager update, not a `where` probe. */
function updateCalls(): Array<{ command: string; args: string[] }> {
	return spawnMock.mock.calls
		.map(([command, args]) => ({ command, args: args ?? [] }))
		.filter(
			(call: { command: string; args: string[] }) =>
				call.args.includes("update") || call.args.includes("upgrade"),
		);
}

/**
 * Answer the package-manager availability probe, then answer the update with
 * `outcome`. `bump` is the version the update leaves behind on success.
 */
function stubSpawn(
	outcome: "ok" | "fail",
	bump?: Record<string, string>,
): void {
	spawnMock.mockImplementation(async (_command: string, args: string[]) => {
		if (!args.includes("update") && !args.includes("upgrade")) {
			// `where npm` / `which npm`
			return { stdout: "npm", stderr: "", status: 0 };
		}
		if (outcome === "fail") {
			return {
				stdout: "",
				stderr: "npm error network ETIMEDOUT registry.npmjs.org",
				status: 1,
			};
		}
		for (const [pkg, version] of Object.entries(bump ?? {})) {
			installFixture(pkg, version);
		}
		return { stdout: "", stderr: "", status: 0 };
	});
}

function logRows(): string[] {
	return sessionLogSpy.mock.calls.map(([message]) => String(message));
}

beforeEach(() => {
	fs.rmSync(TOOLS_DIR, { recursive: true, force: true });
	fs.mkdirSync(NODE_MODULES, { recursive: true });
	spawnMock.mockReset();
	sessionLogSpy.mockReset();
	resetDegradationLedger();
	resetManagedToolRefreshSession();
	delete process.env.PI_LENS_DISABLE_TOOL_REFRESH;
	delete process.env.PI_LENS_TOOL_REFRESH_MAX_PER_SESSION;
	delete process.env.PI_LENS_TOOL_REFRESH_INTERVAL_MS;
	delete process.env.PI_LENS_TOOL_REFRESH_RETRY_MS;
});

afterEach(() => {
	vi.unstubAllEnvs();
});

afterAll(() => {
	fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("refresh candidate selection", () => {
	it("derives candidates from the tool registry, not a hand-kept list", () => {
		const candidates = getRefreshableManagedNpmTools();
		const ids = candidates.map((c) => c.toolId);
		expect(ids).toContain("knip");
		expect(ids).toContain("pyright");
		// An explicit `pkg@1.2.3` pin is the intended version; #589 already
		// reinstalls a managed copy that drifts off one, so it must not be
		// re-resolved here.
		expect(candidates.every((c) => !/[^@]@\d/.test(c.packageName))).toBe(true);
	});

	it("ignores registry entries that are not installed in the managed tree", async () => {
		stubSpawn("ok");
		// Nothing installed at all.
		const outcome = await runManagedToolRefresh(NOW);
		expect(outcome.skipped).toBe("no-candidates");
		expect(updateCalls()).toHaveLength(0);
	});
});

describe("cadence", () => {
	it("refreshes a tool whose stamp is older than the interval", async () => {
		installFixture("knip", "6.4.1");
		writeState({ knip: { checkedAt: NOW - 8 * DAY_MS, version: "6.4.1" } });
		stubSpawn("ok", { knip: "6.32.2" });

		const outcome = await runManagedToolRefresh(NOW);

		expect(updateCalls()).toHaveLength(1);
		expect(updateCalls()[0].args).toContain("knip");
		expect(outcome.refreshed).toHaveLength(1);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "knip",
			previousVersion: "6.4.1",
			currentVersion: "6.32.2",
			changed: true,
			ok: true,
		});
		expect(readState().knip).toMatchObject({
			checkedAt: NOW,
			version: "6.32.2",
		});
	});

	it("refreshes a tool that has never been stamped", async () => {
		installFixture("knip", "6.4.1");
		stubSpawn("ok", { knip: "6.32.2" });

		await runManagedToolRefresh(NOW);

		expect(updateCalls()).toHaveLength(1);
	});

	it("refreshes nothing when every stamp is fresh", async () => {
		installFixture("knip", "6.32.2");
		installFixture("pyright", "1.1.400");
		writeState({
			knip: { checkedAt: NOW - DAY_MS, version: "6.32.2" },
			pyright: { checkedAt: NOW - 2 * DAY_MS, version: "1.1.400" },
		});
		stubSpawn("ok");

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("nothing-due");
		expect(updateCalls()).toHaveLength(0);
	});

	it("spawns at most one update per session even with many stale tools", async () => {
		for (const pkg of ["knip", "pyright", "oxlint", "madge"]) {
			installFixture(pkg, "1.0.0");
		}
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);

		expect(updateCalls()).toHaveLength(1);
	});

	it("takes the oldest stamp first so no tool starves", async () => {
		installFixture("knip", "1.0.0");
		installFixture("pyright", "1.0.0");
		writeState({
			knip: { checkedAt: NOW - 9 * DAY_MS },
			pyright: { checkedAt: NOW - 40 * DAY_MS },
		});
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);

		expect(updateCalls()[0].args).toContain("pyright");
	});
});

describe("session budget", () => {
	it("declines a second refresh inside the same session", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);
		const second = await runManagedToolRefresh(NOW);

		expect(second.skipped).toBe("session-budget");
		expect(updateCalls()).toHaveLength(1);
	});

	it("re-arms at the next session instead of latching for the process", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);
		expect(updateCalls()).toHaveLength(1);

		// The seam `handleSessionStart` calls. No process restart.
		resetManagedToolRefreshSession();

		await runManagedToolRefresh(NOW);
		expect(updateCalls()).toHaveLength(2);
	});

	it("keeps the budget reset reachable from handleSessionStart", () => {
		// The re-arm above is only worth anything if session_start actually runs
		// it. `session-state-conformance.test.ts` derives the reachable set from
		// runtime-session.ts and checks the registry entry against it; this
		// assertion is the local, readable half of the same claim.
		const runtimeSession = fs.readFileSync(
			path.join(process.cwd(), "clients", "runtime-session.ts"),
			"utf-8",
		);
		expect(runtimeSession).toContain("resetManagedToolRefreshSession();");
	});
});

describe("failed refresh", () => {
	it("degrades once, keeps serving, and retries on the shorter cooldown", async () => {
		installFixture("knip", "6.4.1");
		writeState({ knip: { checkedAt: NOW - 8 * DAY_MS, version: "6.4.1" } });
		stubSpawn("fail");

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		// The installed copy is untouched — availability never depends on the
		// refresh succeeding.
		expect(installedVersion("knip")).toBe("6.4.1");

		const groups = getDegradationSummary();
		const group = groups.find((g) => g.kind === "managed-tool-refresh");
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0].subject).toBe("knip");

		const stamp = readState().knip;
		expect(stamp.failed).toBe(true);
		expect(stamp.checkedAt).toBe(NOW);

		// A day later it is due again (retry cooldown), where a success would
		// have held for a week.
		resetDegradationLedger();
		resetManagedToolRefreshSession();
		spawnMock.mockClear();
		stubSpawn("fail");
		await runManagedToolRefresh(NOW + DAY_MS + 1);
		expect(updateCalls()).toHaveLength(1);
	});

	it("does not record the same failing tool twice in one session", async () => {
		installFixture("knip", "6.4.1");
		vi.stubEnv("PI_LENS_TOOL_REFRESH_MAX_PER_SESSION", "2");
		stubSpawn("fail");

		await runManagedToolRefresh(NOW);
		resetManagedToolRefreshSession();
		await runManagedToolRefresh(NOW + 2 * DAY_MS);

		const group = getDegradationSummary().find(
			(g) => g.kind === "managed-tool-refresh",
		);
		expect(group?.count).toBe(1);
	});

	it("does not hand a failing tool's budget slot to the next candidate", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		stubSpawn("fail");

		await runManagedToolRefresh(NOW);

		expect(updateCalls()).toHaveLength(1);
	});
});

describe("unreadable state is not fresh and not stale", () => {
	it("refreshes nothing and records the gap", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		fs.mkdirSync(TOOLS_DIR, { recursive: true });
		fs.writeFileSync(STATE_PATH, "{ this is not json");
		stubSpawn("ok", {});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("state-unreadable");
		expect(updateCalls()).toHaveLength(0);
		const group = getDegradationSummary().find(
			(g) => g.kind === "managed-tool-refresh",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0].subject).toBe("refresh-state");
	});

	it("reports a missing file as empty, not unreadable", async () => {
		fs.rmSync(STATE_PATH, { force: true });
		await expect(readManagedToolRefreshState()).resolves.toMatchObject({
			status: "empty",
		});
	});

	it("reports a corrupt file as unreadable, not empty", async () => {
		fs.mkdirSync(TOOLS_DIR, { recursive: true });
		fs.writeFileSync(STATE_PATH, "[]");
		await expect(readManagedToolRefreshState()).resolves.toMatchObject({
			status: "unreadable",
		});
	});
});

describe("observability", () => {
	it("records the old → new version when a refresh moves a tool", async () => {
		installFixture("knip", "6.4.1");
		stubSpawn("ok", { knip: "6.32.2" });

		await runManagedToolRefresh(NOW);

		expect(
			logRows().some((row) =>
				/managed-tool-refresh knip: 6\.4\.1 → 6\.32\.2/.test(row),
			),
		).toBe(true);
	});

	it("records an unchanged refresh distinctly from a moved one", async () => {
		installFixture("knip", "6.32.2");
		stubSpawn("ok", { knip: "6.32.2" });

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0].changed).toBe(false);
		expect(
			logRows().some((row) =>
				/managed-tool-refresh knip: unchanged at 6\.32\.2/.test(row),
			),
		).toBe(true);
	});

	it("names the tool that kept serving a version it could not verify", async () => {
		installFixture("knip", "6.4.1");
		stubSpawn("fail");

		await runManagedToolRefresh(NOW);

		expect(
			logRows().some(
				(row) =>
					row.includes("managed-tool-refresh knip") &&
					row.includes("keeping 6.4.1"),
			),
		).toBe(true);
	});
});

describe("opt-out", () => {
	it("spawns nothing when the refresh is disabled", async () => {
		installFixture("knip", "6.4.1");
		vi.stubEnv("PI_LENS_DISABLE_TOOL_REFRESH", "1");
		stubSpawn("ok", {});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("disabled");
		expect(updateCalls()).toHaveLength(0);
	});
});
