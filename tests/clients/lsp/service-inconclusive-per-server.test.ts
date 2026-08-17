/**
 * #1549 — the touch verdict is PER SERVER, aggregated honestly.
 *
 * The rule this replaced was `inconclusive = notifyWriteTimedOut ||
 * diagnosticsTimedOut` with both flags TOUCH-WIDE over every spawned server. A
 * cascade neighbour sweep attaches ~5 servers per touch, `timeoutMs` is the MAX
 * over the servers waited on, and opengrep declares 3500ms — so one slow-but-
 * healthy scanner made the whole touch report "nothing is known about this file"
 * even when typescript answered in 100ms. Measured over 6,079 neighbour sweeps:
 * 97.6% inconclusive, against 15% for ordinary edit-time touches in the same
 * window; a post-#1528 dogfood still showed 37/37 inconclusive with the flood
 * fixed, which is what confirmed the merge rule as the driver.
 *
 * What must hold now:
 *   1. An answered primary beside a slow auxiliary is NOT inconclusive — its
 *      findings are usable — and the auxiliary is named as a coverage gap
 *      (`confirmation: "partial"` + `unconfirmedServerIds`, the #1493/#1533
 *      machinery), so nothing reads it as a clean bill of health.
 *   2. A primary that produced no evidence still makes the touch inconclusive
 *      (the fix may only ever NARROW a verdict, never invent a confirmation).
 *   3. An auxiliary's notify-write failure is a coverage gap too, not a verdict.
 *   4. A primary's notify-write failure IS a verdict, attributed as such.
 *   5. `inconclusiveServerIds`/`inconclusiveReason` name who and why, on the
 *      result and in `lsp_touch_file`/`lsp_diagnostics_timeout` — the issue's
 *      observability contract, so the next forensic sweep reads the cause
 *      instead of inferring it from duration histograms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTouchVerdict } from "../../../clients/lsp/diagnostic-binding.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/latency-logger.js", () => ({ logLatency }));
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

const FILE = "C:/repo/main.ts";

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
		...(role && { role }),
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

function makeDiagnostic(message: string) {
	return {
		severity: 1 as const,
		message,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 5 },
		},
	};
}

/**
 * A client whose wait settles after `delayMs`, and which advances the PER-PATH
 * publication stamp (#1531) only when it actually publishes something —
 * findings, or an empty result with `publishesWhenClean`. That stamp is the
 * evidence the per-server verdict reads, so a double that bumps it
 * unconditionally would make every probe here vacuous (defect shape 7).
 */
function makeClient(
	delayMs: number,
	diags: ReturnType<typeof makeDiagnostic>[] = [],
	options: {
		serverId: string;
		publishesWhenClean?: boolean;
		/** Model a write that never lands (stalled stdin / backpressure). */
		hangingNotify?: boolean;
	},
) {
	let settled = false;
	let version = 0;
	const stampsByPath = new Map<string, number>();
	return {
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		getLaunchVariant: () => undefined,
		serverId: options.serverId,
		root: "C:/repo",
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		getDiagnostics: vi.fn(() => (settled ? diags : [])),
		notify: {
			open: options.hangingNotify
				? vi.fn(() => new Promise<void>(() => {}))
				: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		pingLiveness: vi.fn().mockResolvedValue(true),
		waitForDiagnostics: vi.fn(
			(filePath: string) =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						settled = true;
						if (diags.length > 0 || options.publishesWhenClean) {
							version += 1;
							stampsByPath.set(filePath, version);
						}
						resolve();
					}, delayMs),
				),
		),
	};
}

/** The cascade neighbour fan-out's own touch shape (integration.ts). */
const CASCADE_TOUCH = {
	clientScope: "all" as const,
	collectDiagnostics: true as const,
	diagnostics: "document" as const,
	maxClientWaitMs: 1000,
	silent: true,
	source: "cascade",
};

function latencyRows(phase: string) {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter((entry) => entry?.phase === phase);
}

async function runTouch(
	primary: ReturnType<typeof makeClient>,
	aux: ReturnType<typeof makeClient>,
) {
	const { LSPService } = await import("../../../clients/lsp/index.js");
	const service = new LSPService();
	getServersForFileWithConfig.mockReturnValue([
		makeServer("ts-primary"),
		makeServer("opengrep", "auxiliary"),
	]);
	createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
		options?.serverId === "opengrep" ? aux : primary,
	);
	const touch = service.touchFile(FILE, "const x = 1;", CASCADE_TOUCH);
	await vi.advanceTimersByTimeAsync(8000);
	return await touch;
}

describe("#1549 — per-server touch verdict", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
	});

	it("tonight's shape: an answered primary beside a slow auxiliary is USABLE, not inconclusive", async () => {
		// Exactly the observed sweep touch: typescript publishes a finding at 100ms,
		// opengrep needs 5000ms against a 1000ms cap, so the aggregate deadline
		// (max over waited servers) lapses on the auxiliary's account alone.
		const result = await runTouch(
			makeClient(100, [makeDiagnostic("primary error")], {
				serverId: "ts-primary",
			}),
			makeClient(5000, [], { serverId: "opengrep" }),
		);

		// The verdict under test.
		expect(result?.inconclusive).toBeUndefined();
		expect(result?.inconclusiveReason).toBeUndefined();
		// The primary's findings flow to the consumer.
		expect((result?.diags ?? []).map((d) => d.message)).toContain(
			"primary error",
		);
		// And the coverage claim is withdrawn, naming the scanner — so
		// `isConfirmedTouch` still fails closed and no cache is seeded from this.
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
	});

	it("the same shape on a CLEAN primary: confirmed-empty findings survive as partial", async () => {
		// The higher-frequency half of the sweep — a neighbour with nothing wrong.
		// The primary publishes an empty result (evidence that it ran), so the touch
		// speaks for it; only opengrep's coverage is missing.
		const result = await runTouch(
			makeClient(100, [], { serverId: "ts-primary", publishesWhenClean: true }),
			makeClient(5000, [], { serverId: "opengrep" }),
		);

		expect(result?.inconclusive).toBeUndefined();
		expect(result?.diags).toEqual([]);
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
	});

	it("the latency row attributes the lapse: unansweredServerIds names the aux, attributedToPrimary is false", async () => {
		await runTouch(
			makeClient(100, [makeDiagnostic("primary error")], {
				serverId: "ts-primary",
			}),
			makeClient(5000, [], { serverId: "opengrep" }),
		);

		const timeoutRow = latencyRows("lsp_diagnostics_timeout")[0];
		expect(timeoutRow?.metadata).toMatchObject({
			unansweredServerIds: ["opengrep"],
			attributedToPrimary: false,
		});
		const touchRow = latencyRows("lsp_touch_file")[0];
		expect(touchRow?.metadata).toMatchObject({
			inconclusive: false,
			confirmation: "partial",
		});
		expect(touchRow?.metadata).not.toHaveProperty("inconclusiveReason");
	});

	it("FAIL-SAFE: a primary with no evidence keeps the touch inconclusive, and says so", async () => {
		// The primary settles its wait having published nothing, and is not
		// classified silent-on-clean, so its silence is genuinely ambiguous. The fix
		// may only NARROW a verdict — it must never absolve this touch on the
		// strength of an auxiliary.
		const result = await runTouch(
			makeClient(100, [], { serverId: "ts-primary" }),
			makeClient(5000, [], { serverId: "opengrep" }),
		);

		expect(result?.inconclusive).toBe(true);
		expect(result?.confirmation).toBeUndefined();
		// #1549's observability contract: WHICH server, and WHICH deadline.
		expect(result?.inconclusiveServerIds).toEqual(["ts-primary"]);
		expect(result?.inconclusiveReason).toBe("diagnostics-wait");
		expect(latencyRows("lsp_touch_file")[0]?.metadata).toMatchObject({
			inconclusive: true,
			inconclusiveServerIds: ["ts-primary"],
			inconclusiveReason: "diagnostics-wait",
		});
		expect(latencyRows("lsp_diagnostics_timeout")[0]?.metadata).toMatchObject({
			attributedToPrimary: true,
		});
	});

	it("an AUXILIARY's notify write timing out is a coverage gap, not a verdict", async () => {
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
		// opengrep's write never lands, so whatever it publishes describes OTHER
		// bytes: it answered its wait (`publishesWhenClean`) and is STILL uncovered
		// for this content. That is the union `auxiliaryCoverageGap` cannot see —
		// the write failed before any wait outcome existed.
		const result = await runTouch(
			makeClient(100, [makeDiagnostic("primary error")], {
				serverId: "ts-primary",
			}),
			makeClient(100, [], {
				serverId: "opengrep",
				publishesWhenClean: true,
				hangingNotify: true,
			}),
		);

		expect(result?.inconclusive).toBeUndefined();
		expect((result?.diags ?? []).map((d) => d.message)).toContain(
			"primary error",
		);
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
	});

	it("a PRIMARY's notify write timing out is a verdict, attributed to notify-write", async () => {
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
		// The primary never received this content; a publication it makes anyway is
		// about a different revision. Both auxiliaries healthy — a good scanner must
		// not launder the primary's failure into a confirmation.
		const result = await runTouch(
			makeClient(100, [makeDiagnostic("stale finding")], {
				serverId: "ts-primary",
				hangingNotify: true,
			}),
			makeClient(100, [], { serverId: "opengrep", publishesWhenClean: true }),
		);

		expect(result?.inconclusive).toBe(true);
		expect(result?.inconclusiveServerIds).toEqual(["ts-primary"]);
		expect(result?.inconclusiveReason).toBe("notify-write");
		expect(result?.confirmation).toBeUndefined();
	});
});

describe("#1549 — resolveTouchVerdict (the merge rule, in isolation)", () => {
	it("is conclusive when no primary missed a deadline", () => {
		expect(
			resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds: [],
				diagnosticsTimedOut: false,
				diagnosticsUnansweredServerIds: [],
			}),
		).toEqual({ inconclusive: false });
	});

	it("names the notify-write cause", () => {
		expect(
			resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds: ["typescript"],
				diagnosticsTimedOut: false,
				diagnosticsUnansweredServerIds: [],
			}),
		).toEqual({
			inconclusive: true,
			inconclusiveServerIds: ["typescript"],
			inconclusiveReason: "notify-write",
		});
	});

	it("names the diagnostics-wait cause", () => {
		expect(
			resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds: [],
				diagnosticsTimedOut: true,
				diagnosticsUnansweredServerIds: ["rust-analyzer"],
			}),
		).toEqual({
			inconclusive: true,
			inconclusiveServerIds: ["rust-analyzer"],
			inconclusiveReason: "diagnostics-wait",
		});
	});

	it("reports both deadlines as mixed, deduping the server ids", () => {
		expect(
			resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds: ["typescript"],
				diagnosticsTimedOut: true,
				diagnosticsUnansweredServerIds: ["typescript", "marksman"],
			}),
		).toEqual({
			inconclusive: true,
			inconclusiveServerIds: ["typescript", "marksman"],
			inconclusiveReason: "mixed",
		});
	});

	it("stands on the flag when the attribution is unknowable, rather than blaming nobody", () => {
		// A client with no per-path publication stamp yields no attribution. The
		// verdict must survive — this is the pre-#1549 state, honestly labelled.
		expect(
			resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds: [],
				diagnosticsTimedOut: true,
				diagnosticsUnansweredServerIds: [],
			}),
		).toEqual({ inconclusive: true, inconclusiveReason: "diagnostics-wait" });
	});
});
