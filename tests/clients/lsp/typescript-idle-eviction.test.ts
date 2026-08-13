import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function fakeClient(label: string, busy = false) {
	return {
		label,
		isAlive: vi.fn(() => true),
		isBusy: vi.fn(() => busy),
		shutdown: vi.fn(async () => undefined),
		getWorkspaceDiagnosticsSupport: vi.fn(() => ({
			advertised: false,
			mode: "push-only",
			diagnosticProviderKind: "unavailable",
		})),
	};
}

function configureTypeScriptServer() {
	const spawn = vi.fn(async () => ({
		process: {
			process: { killed: false },
			stdin: {},
			stdout: {},
			stderr: {},
			pid: 1332,
		},
	}));
	getServersForFileWithConfig.mockReturnValue([
		{
			id: "typescript",
			name: "TypeScript",
			extensions: [".ts"],
			root: async () => "/repo",
			spawn,
		},
	]);
	return spawn;
}

describe("TypeScript language-service idle eviction (#1332 b2)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		process.env.PI_LENS_TS_IDLE_EVICT_MS = "20";
	});

	afterEach(() => {
		delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("releases the idle client and transparently rebuilds on the next request", async () => {
		vi.useFakeTimers();
		const first = fakeClient("first");
		const rebuilt = fakeClient("rebuilt");
		createLSPClient.mockResolvedValueOnce(first).mockResolvedValueOnce(rebuilt);
		const spawn = configureTypeScriptServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		expect((await service.getClientForFile("/repo/main.ts"))?.client).toBe(first);
		await vi.advanceTimersByTimeAsync(20);

		// This is the release assertion: the manager has dropped the only strong
		// client reference and completed the server-owned registry/program teardown.
		expect(service.getAliveClientCount()).toBe(0);
		expect(first.shutdown).toHaveBeenCalledWith({
			reason: "typescript_idle_eviction",
		});

		expect((await service.getClientForFile("/repo/main.ts"))?.client).toBe(rebuilt);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(createLSPClient).toHaveBeenCalledTimes(2);
		await service.shutdown();
	});

	it("does not evict an in-flight client and restarts its idle window", async () => {
		vi.useFakeTimers();
		const client = fakeClient("busy", true);
		createLSPClient.mockResolvedValue(client);
		configureTypeScriptServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		await service.getClientForFile("/repo/main.ts");

		await vi.advanceTimersByTimeAsync(20);
		expect(client.shutdown).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(1);

		client.isBusy.mockReturnValue(false);
		await vi.advanceTimersByTimeAsync(20);
		expect(client.shutdown).toHaveBeenCalledWith({
			reason: "typescript_idle_eviction",
		});
		expect(service.getAliveClientCount()).toBe(0);
	});

	it("unrefs the timer and clears it on service disposal", async () => {
		const client = fakeClient("lifecycle");
		createLSPClient.mockResolvedValue(client);
		configureTypeScriptServer();
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService() as LSPService & {
			typeScriptIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
		};
		await service.getClientForFile("/repo/main.ts");

		const timer = [...service.typeScriptIdleTimers.values()][0];
		expect(timer).toBeDefined();
		expect(timer.hasRef?.()).toBe(false);
		await service.shutdown();

		expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
		expect(service.typeScriptIdleTimers.size).toBe(0);
	});
});
