import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suspendAt } from "../interleaving-kit.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

vi.mock("../../../clients/latency-logger.js", () => ({ logLatency }));

describe("LSPService race hardening", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("deduplicates concurrent spawn for same server/root key", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = {
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
		};
		const initialize = suspendAt(createLSPClient, async () => client);

		const spawn = vi.fn(async () => ({
				process: {
					process: { killed: false },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 123,
				},
			}));

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";
		const first = service.getClientForFile(file);
		await initialize.admitted;
		const second = service.getClientForFile(file);
		initialize.release();
		const [a, b] = await Promise.all([first, second]);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(a?.client).toBeTruthy();
		expect(b?.client).toBeTruthy();
		initialize.restore();
	});

	it("does not orphan the in-flight client when a waiter times out", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const spawn = vi.fn(async () => ({
				process: {
					process: { killed: false },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 321,
				},
			}));
		const client = {
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
		};
		const initialize = suspendAt(createLSPClient, async () => client);
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";
		const timedOut = service.getClientForFile(file, 1);
		await initialize.admitted;
		expect(await timedOut).toBeUndefined();
		const internal = service as unknown as {
			state: { inFlight: Map<string, unknown>; clients: Map<string, unknown> };
			clientLeases: Map<string, number>;
		};
		expect(internal.state.inFlight.size).toBe(1);
		expect(internal.clientLeases.size).toBe(0);

		initialize.release();
		await service.getClientForFile(file);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(service.getAliveClientCount()).toBe(1);
		expect(internal.state.inFlight.size).toBe(0);
		expect(internal.clientLeases.size).toBe(0);
		await service.shutdown();
		expect(client.shutdown).toHaveBeenCalledTimes(1);
		expect(internal.state.clients.size).toBe(0);
		initialize.restore();
	});

	it("distinguishes a warm-touch budget miss while its single spawn remains in flight", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = {
			serverId: "marksman",
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
			getOperationSupport: () => ({}),
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getAdvertisedCommands: () => [],
			getRawCapabilityKeys: () => [],
			notify: { open: vi.fn().mockResolvedValue(undefined) },
		};
		const initialize = suspendAt(createLSPClient, async () => client);
		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 1875,
			},
		}));
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "marksman",
				name: "Marksman",
				extensions: [".md"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/README.md";
		const firstRead = service.touchFile(file, "# first\n", {
			diagnostics: "none",
			clientScope: "primary",
			maxClientWaitMs: 1,
			source: "tool_call:read",
		});
		await initialize.admitted;
		expect(await firstRead).toBeUndefined();
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					failureKind: "spawn_in_flight_budget_elapsed",
				}),
			}),
		);

		initialize.release();
		await initialize.completed;
		const secondRead = await service.touchFile(file, "# first\n", {
			diagnostics: "none",
			clientScope: "primary",
			maxClientWaitMs: 1,
			source: "tool_call:read",
		});

		expect(secondRead).toEqual({ diags: [] });
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(client.notify.open).toHaveBeenCalledTimes(1);

		logLatency.mockClear();
		getServersForFileWithConfig.mockReturnValue([]);
		expect(
			await service.touchFile("C:/repo/notes.unknown", "none\n", {
				diagnostics: "none",
				clientScope: "primary",
				maxClientWaitMs: 1,
				source: "tool_call:read",
			}),
		).toBeUndefined();
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					failureKind: "no_clients_none_spawning",
				}),
			}),
		);
		initialize.restore();
	});

	// #1766: a resync caller whose own wait budget expires needs to tell "the
	// server's first spawn is still running" apart from "the server is up and
	// stalled". isSpawnInFlight reads the real state.inFlight map — no
	// separate hand-maintained flag — so it must report true exactly while a
	// spawn for a candidate server of the file is unresolved, and false again
	// once it settles.
	it("isSpawnInFlight reports true only while the server's spawn is unresolved", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = {
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
		};
		const initialize = suspendAt(createLSPClient, async () => client);
		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 456,
			},
		}));
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "json",
				name: "JSON",
				extensions: [".json"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/new.json";
		expect(service.isSpawnInFlight(file)).toBe(false);

		const pending = service.getClientForFile(file);
		await initialize.admitted;
		// The spawn is now parked mid-initialize, exactly the state a resync
		// deadline can expire during (#1766's cold-start-vs-wedged race).
		expect(service.isSpawnInFlight(file)).toBe(true);

		initialize.release();
		await pending;
		expect(service.isSpawnInFlight(file)).toBe(false);
		initialize.restore();
	});

	it("isSpawnInFlight is false for a file type with no configured server", () => {
		getServersForFileWithConfig.mockReturnValue([]);
		return import("../../../clients/lsp/index.js").then(({ LSPService }) => {
			const service = new LSPService();
			expect(service.isSpawnInFlight("C:/repo/unknown.xyz")).toBe(false);
		});
	});

	// #1766 review F1: reviewer's probe — a PRIMARY server already alive with
	// zero pending spawn calls, and only an AUXILIARY server (typos, opengrep,
	// …) parked mid-spawn. Auxiliary spawns are routine and concurrent with an
	// alive primary (dispatch/runners/lsp.ts's with-auxiliary path fires one
	// per edit for most files), so isSpawnInFlight must stay false here — the
	// unfiltered prefix scan previously answered true, which would downgrade a
	// genuinely wedged primary to a benign "spawn-in-flight" verdict, the
	// worse misreport direction.
	it("stays false when only an auxiliary server is mid-spawn and the primary is alive", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		let releaseAux!: () => void;
		const auxGate = new Promise<void>((resolve) => {
			releaseAux = resolve;
		});
		let auxAdmitted!: () => void;
		const auxAdmittedPromise = new Promise<void>((resolve) => {
			auxAdmitted = resolve;
		});
		createLSPClient.mockImplementation(
			async ({ serverId }: { serverId: string }) => {
				if (serverId === "typos") {
					auxAdmitted();
					await auxGate;
				}
				return { isAlive: () => true, shutdown: vi.fn(async () => {}) };
			},
		);

		const primarySpawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 1,
			},
		}));
		const auxSpawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 2,
			},
		}));
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: async () => "C:/repo",
				spawn: primarySpawn,
			},
			{
				id: "typos",
				name: "Typos",
				role: "auxiliary",
				extensions: [".ts"],
				root: async () => "C:/repo",
				spawn: auxSpawn,
			},
		]);

		const file = "C:/repo/main.ts";
		// Primary spawns and settles fully first: alive, zero pending spawn calls.
		await service.getClientForFile(file);
		expect(primarySpawn).toHaveBeenCalledTimes(1);
		expect(service.isSpawnInFlight(file)).toBe(false);

		// Kick off the auxiliary spawn and let it park mid-initialize.
		const auxPending = service.getAuxiliaryClientsForFile(
			file,
			new Set(["typos"]),
		);
		await auxAdmittedPromise;

		expect(service.isSpawnInFlight(file)).toBe(false);

		releaseAux();
		await auxPending;
	});

	it("retries broken server after cooldown window", async () => {
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(0);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const spawn = vi.fn(async () => undefined);
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";
		await service.getClientForFile(file);
		await service.getClientForFile(file);
		expect(spawn).toHaveBeenCalledTimes(1);

		now.mockReturnValue(16_000);
		await service.getClientForFile(file);
		expect(spawn).toHaveBeenCalledTimes(2);
		now.mockRestore();
	}, 15000);

	it("does not permanently disable unavailable servers when install is disabled", async () => {
		const savedDisable = process.env.PI_LENS_DISABLE_LSP_INSTALL;
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		const now = vi.spyOn(Date, "now");

		try {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const spawn = vi.fn(async () => undefined);
			getServersForFileWithConfig.mockReturnValue([
				{
					id: "python",
					name: "Python",
					extensions: [".py"],
					root: async () => "C:/repo",
					spawn,
				},
			]);

			const file = "C:/repo/main.py";
			for (let i = 0; i < 6; i++) {
				now.mockReturnValue(i * 16_000);
				await service.getClientForFile(file);
			}

			// A normal unavailable server would be permanently disabled after five
			// misses. With install disabled, misses are policy/unavailable outcomes;
			// keep retrying after cooldown so a newly installed PATH binary can recover
			// without resetting the whole LSP service.
			expect(spawn).toHaveBeenCalledTimes(6);
			expect(createLSPClient).not.toHaveBeenCalled();
		} finally {
			now.mockRestore();
			if (savedDisable === undefined) delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
			else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedDisable;
		}
	}, 15000);

	it("uses a server-specific wait budget override for slow startup", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const spawn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return {
				process: {
					process: { killed: false },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 456,
				},
			};
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "ruby",
				name: "Ruby LSP",
				extensions: [".rb"],
				root: async () => "C:/repo",
				clientWaitTimeoutMs: 50,
				spawn,
			},
		]);

		const file = "C:/repo/main.rb";
		const result = await service.getClientForFile(file, 1);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(result?.client).toBeTruthy();
	});
});
