/**
 * Periodic refresh for the NON-npm managed-tool strategies (#1747).
 *
 * #1730/PR #1746 unfroze the npm entries. The other five strategies stayed
 * frozen on day-one versions because `installTool` only runs when a tool is
 * absent: 27 github entries kept the release they resolved on first install, 6
 * pip entries kept whatever `pip install --user` picked, and the archive/maven
 * entries kept whatever pin was in the registry the day they landed — even
 * after this repo bumped it.
 *
 * These tests pin the policy per strategy, in the shape #1730's tests pin the
 * npm one:
 *   - a stale stamp produces exactly ONE refresh attempt;
 *   - a fresh stamp produces none;
 *   - a failed refresh degrades once, keeps the installed copy serving, and
 *     does not poison the next attempt;
 *   - github re-resolution is bounded: an unchanged tag or a 304 downloads
 *     nothing, and the ETag is replayed as `If-None-Match`;
 *   - archive/maven compare the REGISTRY pin and touch the network only when
 *     it moved.
 *
 * `node:https` and `safeSpawnAsync` are mocked so network calls and spawns can
 * be counted exactly. Everything else — the stamp file, the presence checks,
 * the cadence arithmetic — runs for real against a temp `PI_LENS_HOME`.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
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
		nodePath.join(nodeOs.tmpdir(), "pi-lens-1747-"),
	);
	// TOOLS_DIR / GITHUB_BIN_DIR are module-level consts, so the override must
	// land before the installer module is imported.
	process.env.PI_LENS_HOME = dir;
	return dir;
});

const { spawnMock, sessionLogSpy, httpsGetMock, childSpawnMock } = vi.hoisted(
	() => ({
		spawnMock: vi.fn(),
		sessionLogSpy: vi.fn(),
		httpsGetMock: vi.fn(),
		childSpawnMock: vi.fn(),
	}),
);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, default: actual, spawn: childSpawnMock };
});

vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: spawnMock,
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

vi.mock("node:https", () => ({
	default: { get: httpsGetMock },
	get: httpsGetMock,
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
import {
	getRefreshableManagedTools,
	resetProbeCacheStateForTesting,
	TOOLS,
} from "../../../clients/installer/index.js";
import {
	getManagedToolRefreshStatePath,
	runManagedToolRefresh,
} from "../../../clients/installer/managed-tool-refresh.js";
import { resetManagedToolRefreshSession } from "../../../clients/installer/managed-tool-refresh-session.js";

const TOOLS_DIR = path.join(TEST_HOME, "tools");
const BIN_DIR = path.join(TEST_HOME, "bin");
const PROBE_CACHE_PATH = path.join(TEST_HOME, "probe-cache.json");
const STATE_PATH = getManagedToolRefreshStatePath();
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const SPOTBUGS_PIN =
	"https://github.com/spotbugs/spotbugs/releases/download/4.10.2/spotbugs-4.10.2.tgz";
const KTFMT_PIN =
	"https://repo1.maven.org/maven2:com.facebook:ktfmt:0.63:with-dependencies";

// --- fixtures -------------------------------------------------------------

/** Put a managed-bin artifact where `findGitHubToolPath` looks for it. */
function installManagedBin(binaryName: string): void {
	fs.mkdirSync(BIN_DIR, { recursive: true });
	for (const name of [binaryName, `${binaryName}.exe`]) {
		fs.writeFileSync(path.join(BIN_DIR, name), "#!/bin/sh\nexit 0\n");
	}
}

/** Record a pip/gem tool in the persisted probe cache, pointing at a real file. */
function installProbeCached(toolId: string): void {
	fs.mkdirSync(TEST_HOME, { recursive: true });
	const binPath = path.join(TEST_HOME, `${toolId}-bin`);
	fs.writeFileSync(binPath, "");
	const existing = fs.existsSync(PROBE_CACHE_PATH)
		? JSON.parse(fs.readFileSync(PROBE_CACHE_PATH, "utf-8"))
		: {};
	existing[toolId] = { path: binPath, mtimeMs: 1, cachedAt: NOW };
	fs.writeFileSync(PROBE_CACHE_PATH, JSON.stringify(existing));
	resetProbeCacheStateForTesting();
}

function writeState(tools: Record<string, unknown>): void {
	fs.mkdirSync(TOOLS_DIR, { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify({ version: 1, tools }, null, 2));
}

function readState(): Record<
	string,
	{
		checkedAt: number;
		version?: string;
		resolutionId?: string;
		etag?: string;
		failed?: boolean;
	}
> {
	return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")).tools;
}

// --- https mock -----------------------------------------------------------

interface FakeResponse {
	statusCode: number;
	headers?: Record<string, string>;
	body?: Buffer | string;
}

let httpsRoutes: Array<{
	match: (url: string) => boolean;
	respond: (
		url: string,
		headers: Record<string, string>,
	) => FakeResponse | "error";
}> = [];

function httpsUrls(): string[] {
	return httpsGetMock.mock.calls.map(([url]) => String(url));
}

function httpsHeadersFor(urlFragment: string): Record<string, string> {
	const call = httpsGetMock.mock.calls.find(([url]) =>
		String(url).includes(urlFragment),
	);
	return (call?.[1]?.headers ?? {}) as Record<string, string>;
}

httpsGetMock.mockImplementation(
	(
		url: string,
		options: { headers?: Record<string, string> },
		callback: (res: unknown) => void,
	) => {
		const request = new EventEmitter();
		const route = httpsRoutes.find((candidate) => candidate.match(url));
		queueMicrotask(() => {
			if (!route) {
				request.emit("error", new Error(`no route for ${url}`));
				return;
			}
			const outcome = route.respond(url, options.headers ?? {});
			if (outcome === "error") {
				request.emit("error", new Error(`network down for ${url}`));
				return;
			}
			const res = new EventEmitter() as EventEmitter & {
				statusCode: number;
				headers: Record<string, string>;
				resume: () => void;
			};
			res.statusCode = outcome.statusCode;
			res.headers = outcome.headers ?? {};
			res.resume = () => {};
			callback(res);
			queueMicrotask(() => {
				if (outcome.body !== undefined) {
					res.emit("data", Buffer.from(outcome.body));
				}
				res.emit("end");
			});
		});
		return request;
	},
);

/**
 * `verifyToolBinary` runs the refreshed artifact through a bare
 * `child_process.spawn`, not `safeSpawnAsync`, so the post-refresh verification
 * needs its own stub. Default: the artifact runs and prints a version.
 */
let verifyExitCode = 0;

function installDefaultVerifySpawn(): void {
	childSpawnMock.mockImplementation(() => {
		const proc = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
		};
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		queueMicrotask(() => {
			proc.stdout.emit("data", "1.2.3");
			proc.emit("exit", verifyExitCode, null);
		});
		return proc;
	});
}

/** A `releases/latest` route for shfmt returning `tag`, plus its asset. */
function routeGitHubRelease(
	tag: string,
	options: { etag?: string; notModified?: boolean } = {},
): void {
	httpsRoutes.push({
		match: (url) => url.includes("api.github.com"),
		respond: (_url, headers) => {
			if (options.notModified && headers["If-None-Match"]) {
				return {
					statusCode: 304,
					headers: options.etag
						? { etag: options.etag }
						: ({} as Record<string, string>),
				};
			}
			return {
				statusCode: 200,
				headers: options.etag
					? { etag: options.etag }
					: ({} as Record<string, string>),
				body: JSON.stringify({
					tag_name: tag,
					assets: [
						{
							name: `shfmt_${tag}_linux_amd64`,
							browser_download_url: `https://github.com/mvdan/sh/releases/download/${tag}/shfmt_${tag}_linux_amd64`,
						},
						{
							name: `shfmt_${tag}_windows_amd64.exe`,
							browser_download_url: `https://github.com/mvdan/sh/releases/download/${tag}/shfmt_${tag}_windows_amd64.exe`,
						},
						{
							name: `shfmt_${tag}_darwin_amd64`,
							browser_download_url: `https://github.com/mvdan/sh/releases/download/${tag}/shfmt_${tag}_darwin_amd64`,
						},
					],
				}),
			};
		},
	});
	httpsRoutes.push({
		match: (url) => url.includes("github.com/mvdan/sh/releases/download"),
		respond: () => ({ statusCode: 200, body: Buffer.from("fake-binary") }),
	});
}

function assetDownloads(): string[] {
	return httpsUrls().filter((url) => url.includes("/releases/download/"));
}

function apiCalls(): string[] {
	return httpsUrls().filter((url) => url.includes("api.github.com"));
}

// --- spawn mock -----------------------------------------------------------

/**
 * Answer every spawn with `status: 0` unless the command matches `failing`.
 * Recorded so the test can assert exactly which package-manager invocations ran.
 */
function stubSpawn(options: { fail?: RegExp } = {}): void {
	spawnMock.mockImplementation(async (command: string, args: string[]) => {
		const line = `${command} ${(args ?? []).join(" ")}`;
		if (options.fail?.test(line)) {
			return { stdout: "", stderr: `boom: ${line}`, status: 1 };
		}
		return { stdout: "1.2.3", stderr: "", status: 0 };
	});
}

function spawnLines(): string[] {
	return spawnMock.mock.calls.map(
		([command, args]) => `${command} ${(args ?? []).join(" ")}`,
	);
}

/** Spawns that are a package-manager install/upgrade, not a version probe. */
function installSpawns(): string[] {
	return spawnLines().filter((line) =>
		/\binstall\b|\bupdate\b|\bupgrade\b/.test(line),
	);
}

function degradationCount(): number {
	return (
		getDegradationSummary().find((g) => g.kind === "managed-tool-refresh")
			?.count ?? 0
	);
}

function degradationSubjects(): string[] {
	return (
		getDegradationSummary()
			.find((g) => g.kind === "managed-tool-refresh")
			?.latestReasons.map((r) => r.subject) ?? []
	);
}

function logRows(): string[] {
	return sessionLogSpy.mock.calls.map(([message]) => String(message));
}

/**
 * Every OTHER refreshable tool gets a fresh stamp, so a test that installs one
 * fixture is asserting about that fixture and not racing 60 registry entries
 * for the single per-session slot.
 */
function freshenAllExcept(
	toolId: string,
	extra: Record<string, unknown> = {},
): void {
	const tools: Record<string, unknown> = {};
	for (const tool of getRefreshableManagedTools()) {
		if (tool.toolId === toolId) continue;
		tools[tool.toolId] = { checkedAt: NOW };
	}
	writeState({ ...tools, ...extra });
}

let originalPath: string | undefined;

beforeEach(() => {
	fs.rmSync(TOOLS_DIR, { recursive: true, force: true });
	fs.rmSync(BIN_DIR, { recursive: true, force: true });
	fs.rmSync(PROBE_CACHE_PATH, { force: true });
	fs.mkdirSync(TOOLS_DIR, { recursive: true });
	httpsRoutes = [];
	verifyExitCode = 0;
	httpsGetMock.mockClear();
	childSpawnMock.mockReset();
	installDefaultVerifySpawn();
	spawnMock.mockReset();
	sessionLogSpy.mockReset();
	resetDegradationLedger();
	resetManagedToolRefreshSession();
	resetProbeCacheStateForTesting();
	stubSpawn();
	// `installMavenTool` gates on a JRE via a PATH walk, so give it one.
	originalPath = process.env.PATH;
	const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1747-java-"));
	for (const name of ["java", "java.exe"]) {
		fs.writeFileSync(path.join(fakeBin, name), "x");
	}
	process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
	delete process.env.PI_LENS_DISABLE_TOOL_REFRESH;
	delete process.env.PI_LENS_TOOL_REFRESH_MAX_PER_SESSION;
});

afterEach(() => {
	if (originalPath !== undefined) process.env.PATH = originalPath;
	vi.unstubAllEnvs();
});

afterAll(() => {
	fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// --- candidate derivation -------------------------------------------------

describe("candidate derivation covers every strategy", () => {
	it("derives all six strategies from the registry, not a hand-kept list", () => {
		const byStrategy = new Map<string, number>();
		for (const tool of getRefreshableManagedTools()) {
			byStrategy.set(tool.strategy, (byStrategy.get(tool.strategy) ?? 0) + 1);
		}
		// The five strategies #1730/#1746 left frozen.
		expect(byStrategy.get("github")).toBeGreaterThan(0);
		expect(byStrategy.get("pip")).toBeGreaterThan(0);
		expect(byStrategy.get("archive")).toBeGreaterThan(0);
		expect(byStrategy.get("maven")).toBeGreaterThan(0);
		expect(byStrategy.get("gem")).toBeGreaterThan(0);
		expect(byStrategy.get("npm")).toBeGreaterThan(0);
	});

	it("admits every registry entry whose coordinate can move on this platform", () => {
		const derived = new Set(
			getRefreshableManagedTools().map((tool) => tool.toolId),
		);
		const expected = TOOLS.filter(
			(tool) =>
				tool.installStrategy === "github" ||
				tool.installStrategy === "pip" ||
				tool.installStrategy === "gem" ||
				tool.installStrategy === "maven",
		).map((tool) => tool.id);
		// A single missing id here is the single-source-of-truth defect this
		// derivation exists to prevent.
		expect(expected.filter((id) => !derived.has(id))).toEqual([]);
	});

	it("records the registry pin as the resolution identity for archive and maven", () => {
		const byId = new Map(
			getRefreshableManagedTools().map((tool) => [tool.toolId, tool]),
		);
		expect(byId.get("spotbugs")?.pinnedCoordinate).toBe(SPOTBUGS_PIN);
		expect(byId.get("ktfmt")?.pinnedCoordinate).toBe(KTFMT_PIN);
		// github/pip/gem/npm resolve inside their own registry, so they carry none.
		expect(byId.get("shfmt")?.pinnedCoordinate).toBeUndefined();
		expect(byId.get("ruff")?.pinnedCoordinate).toBeUndefined();
	});

	it("never refreshes a tool pi-lens has not installed", async () => {
		// The registry offers plenty of refreshable entries...
		expect(getRefreshableManagedTools().length).toBeGreaterThan(30);
		// ...but nothing is on disk: no bin artifact, no probe cache, no
		// node_modules. A refresh here would be an unrequested install.
		const outcome = await runManagedToolRefresh(NOW);
		expect(outcome.skipped).toBe("no-candidates");
		expect(httpsUrls()).toEqual([]);
		expect(installSpawns()).toEqual([]);
	});
});

// --- github ---------------------------------------------------------------

describe("github strategy", () => {
	it("re-resolves a stale release and installs the new tag", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: { checkedAt: NOW - 8 * DAY_MS, resolutionId: "v3.7.0" },
		});
		routeGitHubRelease("v3.12.0", { etag: 'W/"abc"' });

		const outcome = await runManagedToolRefresh(NOW);

		expect(apiCalls()).toHaveLength(1);
		expect(assetDownloads()).toHaveLength(1);
		expect(outcome.refreshed).toHaveLength(1);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "shfmt",
			strategy: "github",
			previousVersion: undefined,
			currentVersion: "v3.12.0",
			changed: true,
			ok: true,
		});
		expect(readState().shfmt).toMatchObject({
			checkedAt: NOW,
			resolutionId: "v3.12.0",
			etag: 'W/"abc"',
		});
	});

	it("downloads nothing when the release tag has not moved", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: { checkedAt: NOW - 8 * DAY_MS, resolutionId: "v3.12.0" },
		});
		routeGitHubRelease("v3.12.0", { etag: 'W/"same"' });

		const outcome = await runManagedToolRefresh(NOW);

		expect(apiCalls()).toHaveLength(1);
		expect(assetDownloads()).toEqual([]);
		expect(outcome.refreshed[0]).toMatchObject({ changed: false, ok: true });
	});

	it("replays the stored ETag and treats 304 as unchanged", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: "v3.12.0",
				etag: 'W/"cached"',
			},
		});
		routeGitHubRelease("v3.99.0", { etag: 'W/"cached"', notModified: true });

		const outcome = await runManagedToolRefresh(NOW);

		expect(httpsHeadersFor("api.github.com")["If-None-Match"]).toBe(
			'W/"cached"',
		);
		expect(assetDownloads()).toEqual([]);
		expect(outcome.refreshed[0]).toMatchObject({ changed: false, ok: true });
		expect(readState().shfmt).toMatchObject({ resolutionId: "v3.12.0" });
	});

	it("refreshes nothing when the stamp is still fresh", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: { checkedAt: NOW - DAY_MS, resolutionId: "v3.12.0" },
		});
		routeGitHubRelease("v3.99.0");

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("nothing-due");
		expect(httpsUrls()).toEqual([]);
	});

	it("degrades once and keeps serving when the release query fails", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: "v3.7.0",
				version: "v3.7.0",
				etag: 'W/"old"',
			},
		});
		httpsRoutes.push({
			match: (url) => url.includes("api.github.com"),
			respond: () => "error",
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		expect(assetDownloads()).toEqual([]);
		expect(degradationCount()).toBe(1);
		expect(degradationSubjects()).toContain("shfmt");
		// The managed binary is untouched: availability never depends on refresh.
		expect(fs.existsSync(path.join(BIN_DIR, "shfmt"))).toBe(true);
		const stamp = readState().shfmt;
		expect(stamp.failed).toBe(true);
		expect(stamp.resolutionId).toBe("v3.7.0");
		// A failed run must not persist a validator: replaying it would make the
		// retry a 304 and skip the install that never happened.
		expect(stamp.etag).toBeUndefined();
	});

	it("degrades when the refreshed binary does not run", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: "v3.7.0",
				version: "v3.7.0",
			},
		});
		routeGitHubRelease("v3.12.0", { etag: 'W/"new"' });
		// The download succeeds, the asset is written, and the binary is broken.
		verifyExitCode = 1;

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false });
		expect(degradationCount()).toBe(1);
		const stamp = readState().shfmt;
		expect(stamp.failed).toBe(true);
		// The new tag is NOT recorded: recording it would make the next refresh
		// think the broken release is the installed one and never retry.
		expect(stamp.resolutionId).toBe("v3.7.0");
		expect(stamp.etag).toBeUndefined();
	});

	it("names the version it kept serving in the session log", async () => {
		installManagedBin("shfmt");
		freshenAllExcept("shfmt", {
			shfmt: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: "v3.7.0",
				version: "v3.7.0",
			},
		});
		httpsRoutes.push({
			match: (url) => url.includes("api.github.com"),
			respond: () => "error",
		});

		await runManagedToolRefresh(NOW);

		expect(
			logRows().some(
				(row) =>
					row.includes("managed-tool-refresh shfmt") &&
					row.includes("keeping v3.7.0"),
			),
		).toBe(true);
	});
});

// --- pip / gem ------------------------------------------------------------

describe("pip strategy", () => {
	it("upgrades a stale package with -U, exactly once", async () => {
		installProbeCached("ruff");
		freshenAllExcept("ruff", {
			ruff: { checkedAt: NOW - 8 * DAY_MS, version: "0.5.0" },
		});

		const outcome = await runManagedToolRefresh(NOW);

		const upgrades = installSpawns().filter((line) => line.includes("ruff"));
		expect(upgrades).toHaveLength(1);
		// `-U` is the whole fix: without it pip leaves the installed copy alone.
		expect(upgrades[0]).toMatch(/install -U --user ruff/);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "ruff",
			strategy: "pip",
			ok: true,
		});
	});

	it("refreshes nothing when the stamp is fresh", async () => {
		installProbeCached("ruff");
		freshenAllExcept("ruff", {
			ruff: { checkedAt: NOW - DAY_MS, version: "0.5.0" },
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("nothing-due");
		expect(installSpawns()).toEqual([]);
	});

	it("degrades when the upgrade leaves a binary that cannot report a version", async () => {
		installProbeCached("ruff");
		freshenAllExcept("ruff", {
			ruff: { checkedAt: NOW - 8 * DAY_MS, version: "0.5.0" },
		});
		// The version probe answers before the upgrade and fails after it: the
		// upgrade replaced a working copy with one that cannot run.
		let probes = 0;
		spawnMock.mockImplementation(async (_command: string, args: string[]) => {
			if ((args ?? []).includes("install")) {
				return { stdout: "", stderr: "", status: 0 };
			}
			probes += 1;
			return probes === 1
				? { stdout: "0.5.0", stderr: "", status: 0 }
				: { stdout: "", stderr: "cannot execute", status: 126 };
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false });
		expect(degradationCount()).toBe(1);
		expect(readState().ruff).toMatchObject({ failed: true, version: "0.5.0" });
	});

	it("degrades once and keeps the recorded version when pip fails", async () => {
		installProbeCached("ruff");
		freshenAllExcept("ruff", {
			ruff: { checkedAt: NOW - 8 * DAY_MS, version: "0.5.0" },
		});
		stubSpawn({ fail: /install -U --user ruff/ });

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		expect(degradationCount()).toBe(1);
		expect(degradationSubjects()).toContain("ruff");
		const stamp = readState().ruff;
		expect(stamp.failed).toBe(true);
		expect(stamp.version).toBe("0.5.0");
	});
});

describe("gem strategy", () => {
	it("re-runs the install command, which is gem's upgrade command", async () => {
		installProbeCached("rubocop");
		freshenAllExcept("rubocop", {
			rubocop: { checkedAt: NOW - 8 * DAY_MS, version: "1.60.0" },
		});

		const outcome = await runManagedToolRefresh(NOW);

		const installs = installSpawns().filter((line) => line.includes("rubocop"));
		expect(installs).toHaveLength(1);
		expect(installs[0]).toMatch(/^gem install rubocop --no-document$/);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "rubocop",
			strategy: "gem",
			ok: true,
		});
	});

	it("degrades once when gem fails", async () => {
		installProbeCached("rubocop");
		freshenAllExcept("rubocop", {
			rubocop: { checkedAt: NOW - 8 * DAY_MS, version: "1.60.0" },
		});
		stubSpawn({ fail: /gem install rubocop/ });

		await runManagedToolRefresh(NOW);

		expect(degradationCount()).toBe(1);
		expect(degradationSubjects()).toContain("rubocop");
		expect(readState().rubocop.failed).toBe(true);
	});
});

// --- archive / maven ------------------------------------------------------

describe("archive and maven strategies compare the registry pin", () => {
	it("touches the network for archive only when the pin moved", async () => {
		installManagedBin("spotbugs");
		freshenAllExcept("spotbugs", {
			spotbugs: { checkedAt: NOW - 8 * DAY_MS, resolutionId: SPOTBUGS_PIN },
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(httpsUrls()).toEqual([]);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "spotbugs",
			strategy: "archive",
			changed: false,
			ok: true,
		});
		expect(readState().spotbugs).toMatchObject({
			checkedAt: NOW,
			resolutionId: SPOTBUGS_PIN,
		});
	});

	it("reinstalls archive exactly once when the recorded pin is stale", async () => {
		installManagedBin("spotbugs");
		freshenAllExcept("spotbugs", {
			spotbugs: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: `${SPOTBUGS_PIN}-old`,
			},
		});
		httpsRoutes.push({
			match: (url) => url.includes("spotbugs"),
			respond: () => ({ statusCode: 200, body: Buffer.from("archive-bytes") }),
		});

		await runManagedToolRefresh(NOW);

		expect(httpsUrls().filter((url) => url === SPOTBUGS_PIN)).toHaveLength(1);
	});

	it("degrades once and keeps the old pin when the archive reinstall fails", async () => {
		installManagedBin("spotbugs");
		freshenAllExcept("spotbugs", {
			spotbugs: {
				checkedAt: NOW - 8 * DAY_MS,
				resolutionId: `${SPOTBUGS_PIN}-old`,
			},
		});
		httpsRoutes.push({
			match: (url) => url.includes("spotbugs"),
			respond: () => "error",
		});

		await runManagedToolRefresh(NOW);

		expect(degradationCount()).toBe(1);
		expect(degradationSubjects()).toContain("spotbugs");
		const stamp = readState().spotbugs;
		expect(stamp.failed).toBe(true);
		expect(stamp.resolutionId).toBe(`${SPOTBUGS_PIN}-old`);
		// The shim is still there — a failed refresh never removes the tool.
		expect(fs.existsSync(path.join(BIN_DIR, "spotbugs"))).toBe(true);
	});

	it("touches the network for maven only when the GAV moved", async () => {
		installManagedBin("ktfmt");
		freshenAllExcept("ktfmt", {
			ktfmt: { checkedAt: NOW - 8 * DAY_MS, resolutionId: KTFMT_PIN },
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(httpsUrls()).toEqual([]);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "ktfmt",
			strategy: "maven",
			changed: false,
			ok: true,
		});
	});

	it("redownloads the maven JAR when the registry bumps the version", async () => {
		installManagedBin("ktfmt");
		freshenAllExcept("ktfmt", {
			ktfmt: { checkedAt: NOW - 8 * DAY_MS, resolutionId: `${KTFMT_PIN}-old` },
		});
		httpsRoutes.push({
			match: (url) => url.includes("repo1.maven.org"),
			respond: () => ({ statusCode: 200, body: Buffer.from("jar-bytes") }),
		});

		await runManagedToolRefresh(NOW);

		expect(
			httpsUrls().filter((url) => url.includes("ktfmt-0.63")),
		).toHaveLength(1);
		expect(readState().ktfmt).toMatchObject({ resolutionId: KTFMT_PIN });
	});
});

// --- shared budget --------------------------------------------------------

describe("one budget across all strategies", () => {
	it("spends a single slot even when every strategy has a stale tool", async () => {
		installManagedBin("shfmt");
		installManagedBin("spotbugs");
		installManagedBin("ktfmt");
		installProbeCached("ruff");
		installProbeCached("rubocop");
		routeGitHubRelease("v3.12.0");
		httpsRoutes.push({ match: () => true, respond: () => "error" });
		// No stamps at all: everything is due.

		const outcome = await runManagedToolRefresh(NOW);

		// Exactly one refresh happened across five stale strategies — not none,
		// and not one per strategy.
		expect(outcome.refreshed).toHaveLength(1);
		expect(apiCalls().length + installSpawns().length).toBeLessThanOrEqual(1);
	});

	it("re-arms across sessions rather than latching for the process", async () => {
		installProbeCached("ruff");
		installProbeCached("rubocop");

		await runManagedToolRefresh(NOW);
		const first = installSpawns().length;
		resetManagedToolRefreshSession();
		await runManagedToolRefresh(NOW);

		expect(installSpawns().length).toBe(first + 1);
	});
});
