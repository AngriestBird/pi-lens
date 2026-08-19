/**
 * #1669: `workspace/diagnostic/refresh` handler + negotiated
 * `textDocumentSync.change` kind honored on outgoing `didChange`.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc";

import {
	handleNotifyChange,
	handleNotifyOpen,
	setupIncomingHandlers,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { WatchedFilesQueue } from "../../../clients/lsp/watch-queue.js";
import {
	loadWorkspaceDiagnosticsCache,
	saveWorkspaceDiagnosticsCache,
	WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import { negotiateSyncKind } from "../../../clients/lsp/sync-kind.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);

function createMockConnection(): MessageConnection {
	return {
		sendNotification: vi.fn().mockResolvedValue(undefined),
		sendRequest: vi.fn().mockResolvedValue(undefined),
		onNotification: vi.fn(),
		onRequest: vi.fn().mockResolvedValue(undefined),
		onError: vi.fn(),
		onClose: vi.fn(),
		listen: vi.fn(),
		dispose: vi.fn(),
	} as unknown as MessageConnection;
}

function createMockLspProcess() {
	return {
		pid: 12345,
		process: { killed: false, kill: vi.fn() } as unknown as NodeJS.Process,
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() } as unknown as NodeJS.WritableStream,
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() } as unknown as NodeJS.ReadableStream,
		stderr: { on: vi.fn(), off: vi.fn() } as unknown as NodeJS.ReadableStream,
	};
}

function createMockState(overrides?: Partial<LSPClientState>): LSPClientState {
	const diagnosticEmitter = new EventEmitter();
	diagnosticEmitter.setMaxListeners(50);
	const state: LSPClientState = {
		isConnected: true,
		isDestroyed: false,
		shutdownRequested: false,
		exitedAt: undefined,
		connectionDisposed: false,
		lastError: undefined,
		connection: createMockConnection(),
		pushDiagnostics: new Map(),
		pushDiagnosticTimestamps: new Map(),
		documentPullDiagnostics: new Map(),
		documentPullDiagnosticTimestamps: new Map(),
		pullFailureHistory: [],
		pendingDiagnostics: new Map(),
		diagnosticPublicationCounts: new Map(),
		documentOpenedAt: new Map(),
		diagnosticEmitter,
		diagnosticsVersion: 0,
		diagnosticsVersionsByPath: new Map(),
		documentVersions: new Map(),
		diagnosticDocVersions: new Map(),
		documentContentHashes: new Map(),
		diagnosticBindings: new Map(),
		pullResultIds: new Map(),
		workspacePullResultCache: new Map(),
		openDocuments: new Set(),
		closedDocuments: new Set(),
		pendingOpens: new Set(),
		workspaceDiagnosticsSupport: {
			advertised: false,
			mode: "push-only",
			workspaceDiagnostics: false,
			diagnosticProviderKind: "none",
		},
		operationSupport: {
			definition: false,
			typeDefinition: false,
			declaration: false,
			references: false,
			hover: false,
			signatureHelp: false,
			documentSymbol: false,
			workspaceSymbol: false,
			codeAction: false,
			rename: false,
			implementation: false,
			callHierarchy: false,
		},
		staticDiagnosticsMode: "push-only",
		positionEncoding: "utf-16",
		dynamicRegistrations: new Map(),
		advertisedCommands: new Set(),
		serverEditsAllowed: 0,
		serverId: "test-server",
		root: "/project",
		lspProcess: createMockLspProcess() as any,
		watchQueue: undefined as unknown as WatchedFilesQueue,
		...overrides,
	};
	if (!state.watchQueue) {
		state.watchQueue = new WatchedFilesQueue((changes) => {
			void state.connection.sendNotification("workspace/didChangeWatchedFiles", {
				changes,
			});
		});
	}
	return state;
}

describe("workspace/diagnostic/refresh handler (#1669)", () => {
	it("registers a handler that replies null and clears workspacePullResultCache", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-refresh-"));
		const state = createMockState({ root });
		state.workspacePullResultCache.set(TEST_KEY, {
			uri: `file://${TEST_FILE}`,
			resultId: "stale-result-id",
			diagnostics: [],
		});
		setupIncomingHandlers(state, {});

		const calls = vi.mocked(state.connection.onRequest).mock.calls as unknown as Array<
			[string, (...args: unknown[]) => unknown]
		>;
		const registered = calls.find((c) => c[0] === "workspace/diagnostic/refresh");
		expect(registered, "workspace/diagnostic/refresh handler registered").toBeDefined();

		const reply = await registered![1]();
		expect(reply).toBeNull();
		expect(state.workspacePullResultCache.size).toBe(0);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("also clears the persisted workspace-diagnostics cache on disk", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-refresh-cache-"));
		// Pre-populate the persisted sweep cache the way a real sweep would.
		saveWorkspaceDiagnosticsCache(root, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[normalizeMapKey(path.join(root, "app.ts"))]: {
					diagnostics: [],
					count: 0,
					mtimeMs: 1,
					scannedAt: Date.now(),
					scopeKey: "all|",
				},
			},
		});
		expect(
			Object.keys(loadWorkspaceDiagnosticsCache(root)?.entries ?? {}).length,
		).toBe(1);

		const state = createMockState({ root });
		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock.calls as unknown as Array<
			[string, (...args: unknown[]) => unknown]
		>;
		const handler = calls.find((c) => c[0] === "workspace/diagnostic/refresh")?.[1];
		expect(handler).toBeDefined();

		await handler!();

		expect(
			Object.keys(loadWorkspaceDiagnosticsCache(root)?.entries ?? {}).length,
		).toBe(0);
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("negotiateSyncKind (#1669)", () => {
	it("reads the legacy bare-number shape", () => {
		expect(negotiateSyncKind({ textDocumentSync: 2 })).toBe(2);
		expect(negotiateSyncKind({ textDocumentSync: 0 })).toBe(0);
	});

	it("reads TextDocumentSyncOptions.change", () => {
		expect(negotiateSyncKind({ textDocumentSync: { change: 2 } })).toBe(2);
	});

	it("defaults to Full when unspecified, absent, or unrecognized", () => {
		expect(negotiateSyncKind({})).toBe(1);
		expect(negotiateSyncKind(undefined)).toBe(1);
		expect(negotiateSyncKind({ textDocumentSync: { change: 99 } })).toBe(1);
		expect(negotiateSyncKind({ textDocumentSync: "bogus" })).toBe(1);
	});
});

describe("outgoing didChange honors the negotiated sync kind (#1669)", () => {
	function lastDidChangeParams(state: LSPClientState): {
		contentChanges: Array<{ range?: unknown; text: string }>;
	} {
		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const call = [...calls].reverse().find((c) => c[0] === "textDocument/didChange");
		expect(call, "a textDocument/didChange notification was sent").toBeDefined();
		return call![1] as { contentChanges: Array<{ range?: unknown; text: string }> };
	}

	it("Full sync kind: unchanged whole-document event", async () => {
		const state = createMockState({ syncKind: 1 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		const params = lastDidChangeParams(state);
		expect(params.contentChanges).toEqual([{ text: "const y = 2;" }]);
	});

	it("None sync kind: unchanged whole-document event", async () => {
		const state = createMockState({ syncKind: 0 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		const params = lastDidChangeParams(state);
		expect(params.contentChanges).toEqual([{ text: "const y = 2;" }]);
	});

	it("Incremental sync kind: sends a ranged full-document replace, not a shapeless event", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		// Prime the previously-sent content the way didOpen would.
		state.documentContentHashes.set(TEST_KEY, {
			version: 0,
			hash: "irrelevant",
			text: "const x = 1;\nconst y = 1;",
		});

		await handleNotifyChange(state, TEST_FILE, "const x = 1;\nconst y = 2;");

		const params = lastDidChangeParams(state);
		expect(params.contentChanges).toHaveLength(1);
		const [change] = params.contentChanges;
		expect(change.range).toEqual({
			start: { line: 0, character: 0 },
			end: { line: 1, character: "const y = 1;".length },
		});
		expect(change.text).toBe("const x = 1;\nconst y = 2;");
	});

	it("Incremental sync kind with no retained previous text falls back to whole-document (self-heals)", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		// No prior documentContentHashes entry for this path.

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		const params = lastDidChangeParams(state);
		expect(params.contentChanges).toEqual([{ text: "const y = 2;" }]);
	});

	it("recordSentContent binding stays consistent with what was sent under Incremental", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		state.documentContentHashes.set(TEST_KEY, {
			version: 0,
			hash: "irrelevant",
			text: "const x = 1;",
		});

		await handleNotifyChange(state, TEST_FILE, "const x = 2;");

		const recorded = state.documentContentHashes.get(TEST_KEY);
		expect(recorded?.version).toBe(1);
		expect(recorded?.text).toBe("const x = 2;");
	});

	it("Incremental didOpen (fresh document) still sends the full text, never a range", async () => {
		const state = createMockState({ syncKind: 2 });

		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didOpen = calls.find((c) => c[0] === "textDocument/didOpen");
		expect(didOpen).toBeDefined();
		expect((didOpen![1] as { textDocument: { text: string } }).textDocument.text).toBe(
			"const x = 1;",
		);
	});
});
