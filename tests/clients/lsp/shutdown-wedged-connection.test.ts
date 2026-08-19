/**
 * #1620 — clientShutdown must stay bounded when the connection is wedged.
 *
 * The #1459 wedged-write breaker fires precisely when a server's stdin is not
 * draining. clientShutdown then handed that same stdin a synchronous
 * obligation: `await safeSendNotification(connection, "exit", {})` with no
 * timeout. The write never settled and never rejected, so disposal, the
 * lsp_client_shutdown record, removeLspChild, and killProcessTree never ran —
 * every demoted server leaked.
 *
 * These tests drive clientShutdown against a connection double whose
 * "shutdown" request AND "exit" notification both never settle, and assert the
 * teardown still completes. Pre-fix they hang to their own vitest timeout.
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc";
import { removeLspChild } from "../../../clients/instance-registry.js";
import { logLatency } from "../../../clients/latency-logger.js";

// Keep both budgets short so a wedged double is bounded well inside the
// per-test timeout. Assigned before any dynamic `client.js` import below, so
// the module-load-time env reads see these values.
process.env.PI_LENS_LSP_SHUTDOWN_TIMEOUT_MS = "50";
process.env.PI_LENS_LSP_EXIT_NOTIFY_TIMEOUT_MS = "50";

vi.mock("../../../clients/latency-logger.js", () => ({ logLatency: vi.fn() }));
vi.mock("../../../clients/instance-registry.js", () => ({
	recordLspChild: vi.fn().mockResolvedValue(undefined),
	removeLspChild: vi.fn().mockResolvedValue(undefined),
}));

type ClientModule = typeof import("../../../clients/lsp/client.js");

/**
 * A connection whose sends NEVER settle — the wedged-stdin case. Returning a
 * forever-pending promise is exactly what a jsonrpc write on a non-draining
 * pipe does: it neither resolves nor rejects, so `safeSendNotification`'s catch
 * never runs.
 */
function createWedgedConnection(): MessageConnection {
	return {
		sendNotification: vi.fn(() => new Promise<void>(() => {})),
		sendRequest: vi.fn(() => new Promise<never>(() => {})),
		onNotification: vi.fn(),
		onRequest: vi.fn(),
		onError: vi.fn(),
		onClose: vi.fn(),
		listen: vi.fn(),
		dispose: vi.fn(),
	} as unknown as MessageConnection;
}

function createWedgedState(kill: ReturnType<typeof vi.fn>) {
	const diagnosticEmitter = new EventEmitter();
	diagnosticEmitter.setMaxListeners(50);
	// A partial state is enough: clientShutdown only touches lifecycle fields.
	// Cast once at the boundary rather than restating the full LSPClientState.
	return {
		isConnected: true,
		isDestroyed: false,
		shutdownRequested: false,
		connectionDisposed: false,
		connection: createWedgedConnection(),
		pendingDiagnostics: new Map(),
		pendingOpens: new Set(),
		openDocuments: new Set(),
		openDocumentUris: new Map(),
		projectIdentityProbedFiles: new Set<string>(),
		watchQueue: { cancel: vi.fn() },
		diagnosticEmitter,
		serverId: "wedged",
		root: "/project",
		// pid 0 keeps killProcessTree off both the win32 `taskkill /F /T` branch
		// and the POSIX process-group kill, so the test can never signal a real
		// pid (a recycled pid once nuked a vitest worker — #1114). The direct
		// `proc.kill(SIGTERM)` fallback still runs, which is what we assert on.
		lspProcess: {
			pid: 0,
			process: {
				killed: false,
				exitCode: null,
				signalCode: null,
				kill,
				unref: vi.fn(),
				// Report the child exiting promptly so killProcessTree resolves on
				// the exit event instead of sleeping its 1500ms SIGKILL window.
				once: (_event: "exit", listener: () => void) => {
					setImmediate(listener);
				},
				off: vi.fn(),
			},
		},
	} as unknown as Parameters<ClientModule["clientShutdown"]>[0];
}

describe("clientShutdown with a fully wedged connection (#1620)", () => {
	beforeEach(() => {
		vi.mocked(logLatency).mockReset();
		vi.mocked(removeLspChild).mockClear();
	});

	it("resolves, disposes, deregisters, and kills when both writes hang", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const kill = vi.fn(() => true);
		const state = createWedgedState(kill);

		await mod.clientShutdown(state);

		expect(state.connection.dispose).toHaveBeenCalledTimes(1);
		expect(removeLspChild).toHaveBeenCalledWith(0, undefined);
		expect(kill).toHaveBeenCalled();
	}, 5_000);

	it("records lsp_client_shutdown marking the exit notify as forced", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const state = createWedgedState(vi.fn(() => true));

		await mod.clientShutdown(state);

		const hit = vi
			.mocked(logLatency)
			.mock.calls.find(([e]) => e?.phase === "lsp_client_shutdown");
		expect(hit).toBeDefined();
		const meta = hit![0].metadata!;
		expect(meta.serverId).toBe("wedged");
		expect(meta.shutdownRequestTimedOut).toBe(true);
		expect(meta.exitNotifyTimedOut).toBe(true);
		expect(meta.shutdownOutcome).toBe("forced");
	}, 5_000);

	it("marks a clean handshake graceful", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const state = createWedgedState(vi.fn(() => true));
		state.connection.sendRequest = vi.fn().mockResolvedValue(undefined);
		state.connection.sendNotification = vi.fn().mockResolvedValue(undefined);

		await mod.clientShutdown(state);

		const hit = vi
			.mocked(logLatency)
			.mock.calls.find(([e]) => e?.phase === "lsp_client_shutdown");
		const meta = hit![0].metadata!;
		expect(meta.shutdownRequestTimedOut).toBe(false);
		expect(meta.exitNotifyTimedOut).toBe(false);
		expect(meta.shutdownOutcome).toBe("graceful");
	}, 5_000);

	// The #1459 breaker's caller view: demoteForNotifyStall fires
	// `void client.shutdown()` and immediately drops the entry. If that promise
	// never settles the child is never killed and never deregistered, which is
	// the leak the issue reports. Assert the settle is bounded.
	it("settles inside the shutdown budget so a demotion cannot leak", async () => {
		const mod: ClientModule = await import("../../../clients/lsp/client.js");
		const kill = vi.fn(() => true);
		const state = createWedgedState(kill);

		let settled = false;
		void mod.clientShutdown(state).then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 1000));

		expect(settled, "clientShutdown must settle within 1000ms").toBe(true);
		expect(kill).toHaveBeenCalled();
		expect(removeLspChild).toHaveBeenCalledWith(0, undefined);
	}, 5_000);
});
