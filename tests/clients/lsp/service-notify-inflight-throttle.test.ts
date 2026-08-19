/**
 * #1714 — a full-scan sweep must not out-run an auxiliary scanner's input.
 *
 * #1459 bounded CONCURRENT auxiliary writes to one per server. A
 * `lens_diagnostics mode=full` sweep is sequential inside a server group (#387),
 * so that gate almost never engages: every write is alone in flight. Each write
 * resolves when the pipe accepts the bytes, not when the scanner reads them, so
 * the sweep can hand a single-threaded scanner hundreds of full re-parses faster
 * than it consumes them. On live dogfood that stalled ast-grep twice in two
 * full-scan exposures and both instances had to be force-killed.
 *
 * These tests use a client double that models the wedge the way the real server
 * showed it: past a fixed backlog of unread documents the server stops reading
 * its stdin and stops answering anything. The double, not the test, decides when
 * that happens, so the assertions measure the production behaviour rather than a
 * scripted outcome.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/latency-logger.js", () => ({ logLatency }));

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const ROOT = "C:/repo";
const NOTIFY_BUDGET_MS = 60;
const AUX_KEY = `ast-grep:${normalizeMapKey(ROOT)}`;

function makeFakeProcess() {
	return {
		process: {
			killed: false,
			kill: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		},
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
		stderr: { on: vi.fn(), off: vi.fn() },
		pid: 999,
	};
}

function makeServer(
	id: string,
	role?: "auxiliary",
	extra: Record<string, unknown> = {},
) {
	return {
		id,
		name: id,
		extensions: [".ts"],
		...(role !== undefined && { role }),
		...extra,
		root: async () => ROOT,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

/**
 * A scanner double with a real backlog ceiling.
 *
 * `wedgeAbove` is how many documents it can hold unread before its input path
 * dies. Every `didOpen` adds one; a `pingLiveness` round-trip is what proves it
 * read them, and clears the backlog — that ordering is the real protocol
 * property the fix leans on (one stdin, read in order, so a reply to a request
 * written after N notifications proves those N were read).
 *
 * Once wedged it behaves like the production failure: writes never settle, pings
 * never answer, and it never recovers.
 */
function makeScanner(
	serverId: string,
	options: { wedgeAbove?: number; pingAnswers?: boolean } = {},
) {
	const wedgeAbove = options.wedgeAbove ?? Number.POSITIVE_INFINITY;
	const pingAnswers = options.pingAnswers ?? true;
	const stats = {
		opens: 0,
		pings: 0,
		maxBacklog: 0,
		wedged: false,
	};
	let backlog = 0;
	let version = 0;
	const stampsByPath = new Map<string, number>();
	return {
		stats,
		serverId,
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		getDiagnostics: vi.fn(() => []),
		pingLiveness: vi.fn(async () => {
			stats.pings += 1;
			if (stats.wedged || !pingAnswers) return new Promise<boolean>(() => {});
			backlog = 0;
			return true;
		}),
		notify: {
			open: vi.fn(async () => {
				stats.opens += 1;
				if (stats.wedged) return new Promise<void>(() => {});
				backlog += 1;
				stats.maxBacklog = Math.max(stats.maxBacklog, backlog);
				if (backlog > wedgeAbove) {
					stats.wedged = true;
					return new Promise<void>(() => {});
				}
			}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			(filePath: string) =>
				new Promise<void>((resolve) => {
					version += 1;
					stampsByPath.set(filePath, version);
					resolve();
				}),
		),
	};
}

function makePrimary(serverId: string) {
	let version = 0;
	const stampsByPath = new Map<string, number>();
	return {
		serverId,
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		getDiagnostics: vi.fn(() => []),
		pingLiveness: vi.fn(async () => true),
		notify: {
			open: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			(filePath: string) =>
				new Promise<void>((resolve) => {
					version += 1;
					stampsByPath.set(filePath, version);
					resolve();
				}),
		),
	};
}

function rowsFor(phase: string): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter((entry) => entry?.phase === phase);
}

type TouchResult =
	| { unconfirmedServerIds?: string[]; confirmation?: string }
	| undefined;

/** The sweep's shape: one file after another, each awaited (#387). */
async function sweep(
	service: {
		touchFile: (
			filePath: string,
			content: string,
			options: Record<string, unknown>,
		) => Promise<unknown>;
	},
	files: string[],
): Promise<TouchResult[]> {
	const results: TouchResult[] = [];
	for (const file of files) {
		results.push(
			(await service.touchFile(file, `content of ${file}`, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "lens_diagnostics_full",
			})) as TouchResult,
		);
	}
	return results;
}

function sweepFiles(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${ROOT}/file${i}.ts`);
}

async function makeService() {
	const { LSPService } = await import("../../../clients/lsp/index.js");
	return new LSPService();
}

describe("#1714 — sweep notify volume must not out-run an auxiliary", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		delete process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT;
	});

	it("keeps a sweep-shaped burst below the scanner's wedge ceiling", async () => {
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "4";
		// The scanner dies above six unread documents. A 40-file sweep hands it far
		// more than that before anything asks whether it kept up.
		const aux = makeScanner("ast-grep", { wedgeAbove: 6 });
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
			options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		const files = sweepFiles(40);
		const results = await sweep(service, files);

		// The wedge path is never reached, and the backlog stayed under the ceiling.
		expect(aux.stats.wedged).toBe(false);
		expect(aux.stats.maxBacklog).toBeLessThanOrEqual(4);
		// Every file was still offered to the scanner — throttled, not skipped.
		expect(aux.stats.opens).toBe(40);
		// Nothing was reported as uncovered: the scanner kept up under pacing.
		expect(
			results.filter((r) => r?.unconfirmedServerIds?.includes("ast-grep")),
		).toHaveLength(0);
		// Bounded telemetry: one row per barrier, not per file, and it names the
		// server that hit the ceiling.
		const barriers = rowsFor("lsp_notify_inflight_barrier");
		expect(barriers.length).toBeGreaterThan(0);
		expect(barriers.length).toBeLessThanOrEqual(40 / 4);
		expect(barriers[0]?.metadata).toMatchObject({
			serverId: "ast-grep",
			limit: 4,
			outcome: "drained",
		});
	});

	it("lets a healthy scanner keep full throughput", async () => {
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "4";
		const aux = makeScanner("ast-grep");
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
			options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		const results = await sweep(service, sweepFiles(40));

		expect(aux.stats.opens).toBe(40);
		expect(
			results.filter((r) => r?.unconfirmedServerIds?.includes("ast-grep")),
		).toHaveLength(0);
		// The pacing cost on a healthy server is one round-trip per `limit` files.
		expect(aux.stats.pings).toBeLessThanOrEqual(40 / 4);
	});

	it("defers the file rather than dropping it when the scanner will not answer", async () => {
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "4";
		// Accepts writes but never answers a round-trip: the backlog can never be
		// proven read, so the barrier has to run out of budget.
		const aux = makeScanner("ast-grep", { pingAnswers: false });
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
			options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		const results = await sweep(service, sweepFiles(6));

		// The first four land; the fifth and sixth stall at the barrier.
		expect(aux.stats.opens).toBe(4);
		const uncovered = results.filter((r) =>
			r?.unconfirmedServerIds?.includes("ast-grep"),
		);
		expect(uncovered).toHaveLength(2);
		// A stalled file is NOT a clean file: the touch narrows to "partial" and
		// names the scanner, so the sweep keeps it in the coverage gap.
		for (const result of uncovered) {
			expect(result?.confirmation).toBe("partial");
		}
		const deferred = rowsFor("lsp_notify_resync_deferred");
		expect(
			deferred.filter(
				(row) =>
					(row.metadata as { reason?: string }).reason === "inflight_limit",
			),
		).toHaveLength(2);
		expect(
			rowsFor("lsp_notify_inflight_barrier").at(-1)?.metadata,
		).toMatchObject({ outcome: "stalled" });
	});

	it("honors a per-server ceiling over the shared default", async () => {
		// No env override: the shared default is 8, and the server class asks for 2.
		const aux = makeScanner("ast-grep");
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary", { notifyInflightLimit: 2 }),
		]);
		createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
			options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		await sweep(service, sweepFiles(8));

		expect(aux.stats.maxBacklog).toBeLessThanOrEqual(2);
		expect(rowsFor("lsp_notify_inflight_barrier")[0]?.metadata).toMatchObject({
			limit: 2,
		});
	});

	it("counts the sweep's pre-open burst against the same ceiling", async () => {
		// The pre-open pass (#608/#621) writes `didOpen` straight to every client,
		// without going through `touchFile`. It is the sweep's second source of the
		// same volume, so a scanner at its ceiling must be left out of the burst
		// rather than handed the whole chunk on top of what it already holds.
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "2";
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inflight-preopen-"));
		try {
			for (let i = 0; i < 12; i += 1) {
				fs.writeFileSync(path.join(tmp, `f${i}.ts`), "export const x = 1;\n");
			}
			// Never answers a drain round-trip: once at the ceiling it stays there,
			// so any pre-open that ignored the ledger shows up as an extra backlog.
			const aux = makeScanner("ast-grep", { pingAnswers: false });
			const primary = makePrimary("typescript");
			getServersForFileWithConfig.mockImplementation((fp: string) =>
				fp.endsWith(".ts")
					? [makeServer("typescript"), makeServer("ast-grep", "auxiliary")]
					: [],
			);
			createLSPClient.mockImplementation(
				async (options: { serverId?: string }) =>
					options?.serverId === "ast-grep" ? aux : primary,
			);
			const { LSPService } = await import("../../../clients/lsp/index.js");
			await new LSPService().runWorkspaceDiagnostics(tmp);

			expect(aux.stats.maxBacklog).toBeLessThanOrEqual(2);
		} finally {
			removeTempDirSync(tmp);
		}
	}, 60_000);

	it("re-arms the backlog count when the service resets", async () => {
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "4";
		const aux = makeScanner("ast-grep");
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
			options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		await sweep(service, sweepFiles(3));
		const inflight = (
			service as unknown as { auxNotifyInflight: Map<string, unknown> }
		).auxNotifyInflight;
		expect([...inflight.keys()]).toContain(AUX_KEY);

		// `resetLSPService({reason: "session_start"})` runs this teardown; the map
		// must not carry a previous session's backlog into the next one.
		await (
			service as unknown as { shutdown: (o?: unknown) => Promise<void> }
		).shutdown({ reason: "session_start" });
		expect(inflight.size).toBe(0);
	});
});
