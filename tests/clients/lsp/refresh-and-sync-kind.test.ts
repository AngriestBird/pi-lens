/**
 * #1669: `workspace/diagnostic/refresh` handler + negotiated
 * `textDocumentSync.change` kind honored on outgoing `didChange`.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc";

import {
	clientRequestWorkspaceDiagnostics,
	createLSPClient,
	handleNotifyChange,
	handleNotifyOpen,
	setupIncomingHandlers,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { WatchedFilesQueue } from "../../../clients/lsp/watch-queue.js";
import {
	createWorkspaceDiagnosticsCacheContext,
	loadWorkspaceDiagnosticsCache,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import { negotiateSyncKind } from "../../../clients/lsp/sync-kind.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER_PATH = path.join(__dirname, "../../fixtures/fake-lsp-server.mjs");

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

// #1669 review F8: `openDocumentUris` and `projectIdentityProbedFiles` are
// REQUIRED here — both are `optional` fields on `LSPClientState`, and a
// local factory that omits them exercises production's `?.`-fallback branch
// (e.g. `state.openDocumentUris?.get(normalizedPath) ?? pathToFileURL(...)`)
// instead of the real optional-field-present path every live client
// actually runs under. PR #1682 extracts a shared factory to
// tests/clients/lsp/mock-client-state.ts with this same fix; once it lands,
// this local factory should be replaced with that import instead of kept in
// parallel (single-source-of-truth — do not hand-maintain two copies).
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
		openDocumentUris: new Map(),
		pendingOpens: new Set(),
		projectIdentityProbedFiles: new Set(),
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
		// Pre-populate the persisted sweep cache the way a REAL sweep would —
		// through `createWorkspaceDiagnosticsCacheContext`, which is also what
		// registers `root` as a cwd `clearAllWorkspaceDiagnosticsCaches` (#1669
		// review F1) knows to clear. A raw `saveWorkspaceDiagnosticsCache` call
		// writes the file without ever registering it, which would prove
		// nothing about the refresh handler's real behavior.
		const ctx = createWorkspaceDiagnosticsCacheContext(root);
		ctx.record(path.join(root, "app.ts"), "all|", [], 1);
		ctx.persist();
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
		// #1669 review F5: this assertion is the part that actually
		// distinguishes the fix from a no-op/broken one. Pre-fix (or a fix that
		// never wires `recordSentContent` to retain text under Incremental),
		// `documentContentHashes` never carries a `text` field at all — the
		// whole-document-output assertion above would ALSO pass against that
		// inert baseline, since Full and "missing feature" both send
		// `{ text }`. Checking that this call retained `text` for the path
		// proves the self-heal is genuine: the NEXT change for this path now
		// has a basis to diff against, per `buildContentChanges`'s doc comment.
		expect(state.documentContentHashes.get(TEST_KEY)?.text).toBe("const y = 2;");
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
		// #1669 review F5: didOpen always sending full text is unchanged
		// behavior on BOTH sides of the fix, so the assertion above alone
		// can't tell a real Incremental wire-up from a no-op one. What IS new
		// under Incremental is that `recordSentContent` retains the text so a
		// FOLLOWING didChange has a basis to diff against — assert that here,
		// on the open path specifically.
		expect(state.documentContentHashes.get(TEST_KEY)?.text).toBe("const x = 1;");
	});

	it("counts a lone-CR line ending as a real line break, not part of the previous line (#1669 review F6)", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		// Classic Mac (lone \r, no \n) line ending between two lines. A plain
		// `.split("\n")` sees this as ONE line (`"line0\rline1"`) — pre-fix, the
		// computed range would end at `{ line: 0, character: "line0\rline1".length }`
		// instead of the real last line.
		state.documentContentHashes.set(TEST_KEY, {
			version: 0,
			hash: "irrelevant",
			text: "line0\rline1",
		});

		await handleNotifyChange(state, TEST_FILE, "line0\rline2");

		const params = lastDidChangeParams(state);
		const [change] = params.contentChanges;
		expect(change.range).toEqual({
			start: { line: 0, character: 0 },
			end: { line: 1, character: "line1".length },
		});
	});
});

describe("recordSentContent only mirrors a CONFIRMED send (#1669 review F7)", () => {
	it("does not update documentContentHashes when the didChange notification is swallowed as a stream error", async () => {
		const state = createMockState({ syncKind: 2 });
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		state.documentContentHashes.set(TEST_KEY, {
			version: 0,
			hash: "irrelevant",
			text: "const x = 1;",
		});
		// A stream error is SWALLOWED by `safeSendNotification` (connection
		// error handlers update state separately) — the caller sees a resolved
		// promise, not a rejection, so gating on a thrown error alone would be
		// insufficient.
		vi.mocked(state.connection.sendNotification).mockImplementationOnce(() =>
			Promise.reject(new Error("stream destroyed")),
		);

		await handleNotifyChange(state, TEST_FILE, "const x = 2;");

		// Pre-fix, `recordSentContent` ran unconditionally after the send
		// attempt: this would read `{ version: 1, text: "const x = 2;" }` even
		// though the server never actually received it — desyncing the
		// Incremental mirror from what the server has, with no self-heal.
		const recorded = state.documentContentHashes.get(TEST_KEY);
		expect(recorded?.version).toBe(0);
		expect(recorded?.text).toBe("const x = 1;");
	});

	it("does update documentContentHashes once the send genuinely succeeds", async () => {
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
});

describe("workspace/diagnostic/refresh clears per-document pull state and re-pulls open docs (#1669 review F3)", () => {
	it("drops the same per-path state a resync's clearDiagnosticsForPath drops, and proactively re-pulls open documents under pull mode", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "documentDiagnosticProvider",
			},
		});
		state.openDocuments.add(TEST_KEY);
		state.openDocumentUris!.set(TEST_KEY, pathToFileURL(TEST_FILE).href);
		state.pullResultIds.set(TEST_KEY, "stale-result-id");
		state.documentPullDiagnostics.set(TEST_KEY, [
			{ message: "stale", severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } as any,
		]);
		state.diagnosticBindings.set(TEST_KEY, { contentHash: "stale-hash" });
		state.diagnosticsVersionsByPath.set(TEST_KEY, 5);

		vi.mocked(state.connection.sendRequest).mockResolvedValue({
			kind: "full",
			resultId: "fresh-result-id",
			items: [],
		});

		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock.calls as unknown as Array<
			[string, (...args: unknown[]) => unknown]
		>;
		const handler = calls.find((c) => c[0] === "workspace/diagnostic/refresh")?.[1];
		expect(handler).toBeDefined();

		await handler!();
		// The re-pull is fired without being awaited by the handler itself
		// (never block a request reply on a follow-up round trip) — flush
		// microtasks so it has a chance to actually reach the mock.
		await Promise.resolve();
		await Promise.resolve();

		// #1104 basis dropped — same fields `clearDiagnosticsForPath` drops for
		// a normal resync. Pre-fix, only `workspacePullResultCache` (handled
		// separately, above) was cleared; these all stayed stale.
		expect(state.pullResultIds.has(TEST_KEY)).toBe(false);
		expect(state.diagnosticBindings.has(TEST_KEY)).toBe(false);
		expect(state.diagnosticsVersionsByPath.has(TEST_KEY)).toBe(false);

		// Proactively re-pulled: a textDocument/diagnostic request went out
		// for the open document instead of waiting on its next edit.
		const pullCall = vi
			.mocked(state.connection.sendRequest)
			.mock.calls.find((c) => c[0] === "textDocument/diagnostic");
		expect(pullCall, "textDocument/diagnostic was requested for the open doc").toBeDefined();
	});

	it("does not re-pull under push-only mode (a pull request there would just be refused)", async () => {
		const state = createMockState(); // default workspaceDiagnosticsSupport.mode = "push-only"
		state.openDocuments.add(TEST_KEY);
		state.openDocumentUris!.set(TEST_KEY, pathToFileURL(TEST_FILE).href);
		state.pullResultIds.set(TEST_KEY, "stale-result-id");

		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock.calls as unknown as Array<
			[string, (...args: unknown[]) => unknown]
		>;
		const handler = calls.find((c) => c[0] === "workspace/diagnostic/refresh")?.[1];

		await handler!();
		await Promise.resolve();

		expect(state.pullResultIds.has(TEST_KEY)).toBe(false);
		const pullCall = vi
			.mocked(state.connection.sendRequest)
			.mock.calls.find((c) => c[0] === "textDocument/diagnostic");
		expect(pullCall).toBeUndefined();
	});
});

describe("clientRequestWorkspaceDiagnostics: unchanged report with no cached basis (#1669 review F4)", () => {
	it("falls back to a per-file pull instead of silently dropping the file as clean", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "documentDiagnosticProvider",
			},
		});
		// No workspacePullResultCache entry — simulates right after a refresh
		// cleared it, then a sweep's `workspace/diagnostic` pull runs before
		// this file has a fresh basis again.
		vi.mocked(state.connection.sendRequest).mockImplementation(
			async (method: unknown) => {
				if (method === "workspace/diagnostic") {
					return {
						items: [
							{
								uri: pathToFileURL(TEST_FILE).href,
								kind: "unchanged",
								resultId: "r2",
							},
						],
					};
				}
				if (method === "textDocument/diagnostic") {
					return {
						kind: "full",
						resultId: "r3",
						items: [
							{
								message: "fresh finding",
								severity: 1,
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 1 },
								},
							},
						],
					};
				}
				return undefined;
			},
		);

		const out = await clientRequestWorkspaceDiagnostics(state, 5000);

		expect(out, "workspace/diagnostic pull must not fail outright").toBeDefined();
		const entry = out!.find((r) => normalizeMapKey(r.filePath) === TEST_KEY);
		// Pre-fix, `continue` on a missing `prior` basis dropped this file from
		// `out` entirely — indistinguishable from a genuinely clean file to
		// every caller (`runWorkspaceDiagnosticsSwept`'s doc comment: "a file
		// absent from the result is clean").
		expect(entry, "file must not silently drop out as clean").toBeDefined();
		expect(entry!.diagnostics).toHaveLength(1);
		const fallbackPullCall = vi
			.mocked(state.connection.sendRequest)
			.mock.calls.find((c) => c[0] === "textDocument/diagnostic");
		expect(fallbackPullCall, "fell back to a real per-file pull").toBeDefined();
	});

	it("stays absent when the fallback pull is genuinely clean", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "documentDiagnosticProvider",
			},
		});
		vi.mocked(state.connection.sendRequest).mockImplementation(
			async (method: unknown) => {
				if (method === "workspace/diagnostic") {
					return {
						items: [
							{
								uri: pathToFileURL(TEST_FILE).href,
								kind: "unchanged",
								resultId: "r2",
							},
						],
					};
				}
				if (method === "textDocument/diagnostic") {
					return { kind: "full", resultId: "r3", items: [] };
				}
				return undefined;
			},
		);

		const out = await clientRequestWorkspaceDiagnostics(state, 5000);

		expect(out).toBeDefined();
		expect(
			out!.find((r) => normalizeMapKey(r.filePath) === TEST_KEY),
		).toBeUndefined();
	});
});

// #1669 review F5: every other test in this file drives `handleNotifyChange`
// against a HAND-BUILT `LSPClientState` with `syncKind` set directly by the
// test — none of them exercise the real seam that sets it in production,
// `state.syncKind = negotiateSyncKind(initResult.capabilities)` inside
// `createLSPClient`. This suite spawns the real fake LSP server fixture
// (same pattern as tests/clients/lsp/integration.test.ts) so the sync kind
// is negotiated from an ACTUAL `initialize` response, and asserts on the
// real wire shape of the resulting `didChange` — proof the negotiation seam
// itself, not just `buildContentChanges` in isolation, drives production.
describe("negotiateSyncKind through the real createLSPClient init path (#1669 review F5)", () => {
	it("a server advertising Incremental sync gets a ranged didChange on the wire", async () => {
		const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: {
				...process.env,
				FAKE_LSP_SYNC_KIND: "2", // Incremental
				FAKE_LSP_ECHO_DID_CHANGE: "1",
			},
		});
		const client = await createLSPClient({
			serverId: "fake-incremental",
			process: proc,
			root: process.cwd(),
		});
		try {
			const received: Array<{ contentChanges: Array<{ range?: unknown; text: string }> }> =
				[];
			client.connection.onNotification(
				"$/test/didChangeReceived",
				(params: { contentChanges: Array<{ range?: unknown; text: string }> }) => {
					received.push(params);
				},
			);

			const filePath = path.join(os.tmpdir(), "pi-lens-sync-kind-real-init.ts");
			await client.notify.open(filePath, "const x = 1;\n", "typescript");
			await client.notify.change(filePath, "const x = 1;\nconst y = 2;\n");

			await vi.waitFor(() => {
				expect(received.length).toBeGreaterThan(0);
			});
			const [change] = received[0].contentChanges;
			// The real negotiation from the server's actual `initialize` response
			// drove a RANGED edit — not the whole-document `{ text }` shape a
			// Full-sync (or unwired) client would send.
			expect(change.range).toBeDefined();
			expect(change.text).toBe("const x = 1;\nconst y = 2;\n");
		} finally {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}, 15_000);

	it("a server advertising Full sync (the fixture's default) gets a whole-document didChange", async () => {
		const proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_ECHO_DID_CHANGE: "1" },
		});
		const client = await createLSPClient({
			serverId: "fake-full",
			process: proc,
			root: process.cwd(),
		});
		try {
			const received: Array<{ contentChanges: Array<{ range?: unknown; text: string }> }> =
				[];
			client.connection.onNotification(
				"$/test/didChangeReceived",
				(params: { contentChanges: Array<{ range?: unknown; text: string }> }) => {
					received.push(params);
				},
			);

			const filePath = path.join(os.tmpdir(), "pi-lens-sync-kind-real-init-full.ts");
			await client.notify.open(filePath, "const x = 1;\n", "typescript");
			await client.notify.change(filePath, "const x = 1;\nconst y = 2;\n");

			await vi.waitFor(() => {
				expect(received.length).toBeGreaterThan(0);
			});
			const [change] = received[0].contentChanges;
			expect(change.range).toBeUndefined();
			expect(change.text).toBe("const x = 1;\nconst y = 2;\n");
		} finally {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}, 15_000);
});
