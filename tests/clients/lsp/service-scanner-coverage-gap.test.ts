/**
 * #1459 — a cascade sweep must not drive a scanner into the notify-write
 * breaker, and a scanner's silence must never read as a clean verdict.
 *
 * Before this fix a `clientScope: "all"` sweep fanned a full-text `didOpen`
 * resync at opengrep for every neighbour inside a few milliseconds. Its stdin
 * stopped draining, three per-server write deadlines expired, and the #743
 * breaker opened for 15 s. Every touch inside that window then skipped the
 * scanner and still resolved `confirmation: "confirmed"` — a security blackout
 * that read as scanned-clean.
 *
 * These tests verify:
 *  1. A burst of concurrent resyncs at an auxiliary issues ONE write (the rest
 *     defer), so the breaker never trips, and the deferred touches report the
 *     scanner as uncovered.
 *  2. A write that lands after its deadline retracts the timeout it was charged
 *     for — slow is not broken.
 *  3. A write nothing accepts for the whole wedge window still demotes the
 *     server, so the gate cannot defer a dead input path forever.
 *  4. A touch that skipped a scanner because its breaker was open resolves
 *     `"partial"` and names the scanner, not `"confirmed"`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";

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
const NOTIFY_BUDGET_MS = 100;
const AUX_KEY_PREFIX = `opengrep:${normalizeMapKey(ROOT)}`;

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

function makeServer(id: string, role?: "auxiliary") {
	return {
		id,
		name: id,
		extensions: [".ts"],
		...(role !== undefined && { role }),
		root: async () => ROOT,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

function makeDiagnostic(message: string) {
	return {
		severity: 1 as const,
		message,
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
	};
}

/**
 * A fake client. `writeMs` is how long its `didOpen` takes to be accepted:
 * `undefined` means it never lands (a wedged stdin), 0 means immediately.
 */
function makeClient(
	serverId: string,
	writeMs: number | undefined,
	diags: ReturnType<typeof makeDiagnostic>[] = [],
) {
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
		diagnosticsVersion: 0,
		getDiagnostics: vi.fn(() => diags),
		notify: {
			open: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						if (writeMs === undefined) return;
						setTimeout(resolve, writeMs);
					}),
			),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(async () => undefined),
	};
}

function phases(): string[] {
	return logLatency.mock.calls.map(([entry]) => entry?.phase);
}

function rowsFor(phase: string): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter((entry) => entry?.phase === phase);
}

function brokenKeys(service: unknown): string[] {
	return [
		...(
			service as { state: { broken: Map<string, number> } }
		).state.broken.keys(),
	];
}

function streakKeys(service: unknown): string[] {
	return [
		...(
			service as { notifyWriteBackpressureStreak: Map<string, number> }
		).notifyWriteBackpressureStreak.keys(),
	];
}

async function touchAll(
	service: {
		touchFile: (
			filePath: string,
			content: string,
			options: Record<string, unknown>,
		) => Promise<unknown>;
	},
	files: string[],
) {
	return Promise.all(
		files.map((file) =>
			service.touchFile(file, `content of ${file}`, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "cascade",
			}),
		),
	);
}

describe("#1459 — sweep fan-out must not black out a scanner silently", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
	});

	it("a burst of resyncs issues one write, defers the rest, and never trips the breaker", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The scanner is slow (3x the write budget) but healthy — its write lands.
		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 3);
		const primary = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const files = ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => `${ROOT}/${f}`);
		const pending = touchAll(service, files);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 20);
		const results = (await pending) as Array<
			{ confirmation?: string; unconfirmedServerIds?: string[] } | undefined
		>;

		// The gate let exactly one resync through; the other three deferred.
		expect(aux.notify.open).toHaveBeenCalledTimes(1);
		expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(3);

		// The breaker never opened, and no streak survived the late landing.
		expect(phases()).not.toContain("lsp_notify_backpressure_broken");
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			false,
		);
		expect(streakKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			false,
		);

		// Every deferred touch says so: the scanner never saw that content.
		const deferred = results.filter((r) =>
			r?.unconfirmedServerIds?.includes("opengrep"),
		);
		expect(deferred).toHaveLength(3);
		for (const result of deferred) {
			expect(result?.confirmation).toBe("partial");
		}
		const gapRows = rowsFor("lsp_scanner_coverage_gap");
		expect(gapRows).toHaveLength(3);
		expect(gapRows[0]?.metadata).toMatchObject({
			deferredResyncServerIds: ["opengrep"],
			source: "cascade",
		});
	});

	it("a write that lands after its deadline retracts the timeout it was charged for", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 3);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		// Three sequential slow-but-landing writes. Pre-#1459 each one charged a
		// timeout and the third opened the breaker.
		for (const content of ["one", "two", "three"]) {
			const pending = service.touchFile(`${ROOT}/a.ts`, content, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "cascade",
			});
			await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 10);
			await pending;
		}

		expect(aux.notify.open).toHaveBeenCalledTimes(3);
		expect(rowsFor("lsp_notify_write_late_landed")).toHaveLength(3);
		expect(phases()).not.toContain("lsp_notify_backpressure_broken");
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			false,
		);
	});

	it("a write nothing accepts for the wedge window still demotes the server", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Wedged: the write never lands.
		const aux = makeClient("opengrep", undefined);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		const first = service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 8);
		await first;

		const second = service.touchFile(`${ROOT}/b.ts`, "two", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS);
		await second;

		const demotions = rowsFor("lsp_notify_backpressure_broken");
		expect(demotions).toHaveLength(1);
		expect(
			(demotions[0]?.metadata as { outstandingMs?: number } | undefined)
				?.outstandingMs,
		).toBeGreaterThan(NOTIFY_BUDGET_MS * 5);
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			true,
		);
		expect(aux.shutdown).toHaveBeenCalled();
	});

	it("a scanner skipped for an open breaker makes the touch partial, not confirmed", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const primary = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(primary);

		// The scanner is mid-cooldown, exactly as a #743 demotion leaves it.
		(
			service as unknown as { state: { broken: Map<string, number> } }
		).state.broken.set(AUX_KEY_PREFIX, Date.now() + 15_000);

		const pending = service.touchFile(`${ROOT}/a.ts`, "content", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 20);
		const result = (await pending) as
			| { confirmation?: string; unconfirmedServerIds?: string[] }
			| undefined;

		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
		const gapRows = rowsFor("lsp_scanner_coverage_gap");
		expect(gapRows).toHaveLength(1);
		expect(gapRows[0]?.metadata).toMatchObject({
			brokenSkippedServerIds: ["opengrep"],
		});
	});
});
