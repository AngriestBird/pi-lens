/**
 * #3480: the touch debounce must tell two long documents apart when they
 * differ only in the middle.
 *
 * Recurrence this file prevents: `shouldSkipNotify` compared a length + first
 * 48 + last 48 chars fingerprint, so a same-length middle edit of a >96-char
 * file inside the 1500 ms debounce window was skipped with nothing recorded,
 * and the server kept answering from the previous content.
 *
 * Production chain: the REAL `LSPService.touchFile` -> the REAL
 * `handleNotifyOpen` notify queue -> a mock `MessageConnection` (the process
 * boundary). Only the server registry and client construction are doubled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { fingerprintDocumentContent } from "../../../clients/lsp/document-drift.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { createMockState } from "./mock-client-state.js";

const { getServersForFileWithConfig, createLSPClient } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
	createLSPClient: vi.fn(),
}));

vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
// #3480 round 1: count the fingerprints `touchFile` computes. Wrapped, not
// replaced: every other export is the real module.
vi.mock("../../../clients/lsp/document-drift.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/lsp/document-drift.js")
		>();
	return {
		...actual,
		fingerprintDocumentContent: vi.fn(actual.fingerprintDocumentContent),
	};
});
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

const ROOT = "/repo";
const FILE = "/repo/long.ts";
const HEAD = `// ${"h".repeat(60)}\n`;
const TAIL = `// ${"t".repeat(60)}\n`;
const A = `${HEAD}const x = 1;\n${TAIL}`;
const B = `${HEAD}const x = 2;\n${TAIL}`;

/**
 * `reportRecord: false` builds the client shape #4532 gap 9 F3 is about: one
 * that cannot say what it holds. `reportQueue: false` is the other unanswerable
 * question — a record but no word on whether a send for the path is still to
 * come. Production has neither, so a double is the only way to reach either
 * branch, and the gate must fail CLOSED on both.
 */
async function setup(
	options: { reportRecord?: boolean; reportQueue?: boolean } = {},
) {
	const state = createMockState({ root: ROOT, serverId: "typescript" });
	const client = {
		serverId: "typescript",
		root: ROOT,
		customServer: false,
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
		diagnosticsVersion: 0,
		getDiagnosticsVersionForPath: vi.fn(() => 0),
		getDiagnostics: vi.fn(() => []),
		getAllDiagnostics: vi.fn(() => new Map()),
		getDiagnosticBinding: vi.fn(() => undefined),
		// #4532: the real readers over this double's real state, so the gate's
		// evidence is the queue and record the fixture actually drives. Omitting
		// both is the F3 shape: a client that cannot report a record.
		...(options.reportRecord === false
			? {}
			: {
					getSentContent: (filePath: string) => {
						// Read over the fixture's REAL state — `recordSentContent` writes this
						// map, and `clientModule.sentContentFor` is the same read. Spelled
						// here instead of imported so this fixture also runs against the code
						// before that reader existed, which the F1 red-first proof needs.
						const sent = state.documentContentHashes.get(
							normalizeMapKey(filePath),
						);
						return sent && { hash: sent.hash };
					},
				}),
		...(options.reportQueue === false
			? {}
			: {
					hasNotifyInFlight: (filePath: string) =>
						clientModule.hasNotifyInFlightFor(state, filePath),
				}),
		notify: {
			announceCreated: () => undefined,
			open: (
				filePath: string,
				content: string,
				languageId: string,
				preserveDiagnostics?: boolean,
				silent?: boolean,
				saved?: boolean,
			) =>
				clientModule.handleNotifyOpen(
					state,
					filePath,
					content,
					languageId,
					preserveDiagnostics,
					silent,
					saved,
				),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		pingLiveness: vi.fn().mockResolvedValue(true),
		waitForDiagnostics: vi.fn(async () => {}),
	};
	getServersForFileWithConfig.mockReturnValue([
		{
			id: "typescript",
			name: "typescript",
			extensions: [".ts"],
			idleEviction: "resident",
			root: async () => ROOT,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		},
	]);
	createLSPClient.mockResolvedValue(client);
	const service = new LSPService();
	const texts = () =>
		vi
			.mocked(state.connection.sendNotification)
			.mock.calls.filter(([method]) => /didOpen|didChange/.test(String(method)))
			.map(([method, params]) => {
				const p = params as {
					textDocument?: { text?: string };
					contentChanges?: Array<{ text: string }>;
				};
				return `${String(method).replace("textDocument/", "")}:${
					p.textDocument?.text ?? p.contentChanges?.at(-1)?.text
				}`;
			});
	return { service, texts, state, client };
}

describe("#3480 — touch debounce fingerprint covers the whole document", () => {
	beforeEach(() => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends a same-length middle edit of a long file inside the debounce window", async () => {
		expect(B.length).toBe(A.length);
		expect(A.length).toBeGreaterThan(96);
		const { service, texts } = await setup();

		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		await service.touchFile(FILE, B, { diagnostics: "none", source: "test" });

		expect(texts()).toEqual([`didOpen:${A}`, `didChange:${B}`]);
	});

	// #3480 round 1 N1: one whole-content hash per touch, not one per debounce
	// check and per mark (each a sha256 of up to the whole file).
	it("fingerprints the content once per touch", async () => {
		const { service } = await setup();
		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		const fingerprint = vi.mocked(fingerprintDocumentContent);
		fingerprint.mockClear();

		await service.touchFile(FILE, B, { diagnostics: "none", source: "test" });

		expect(fingerprint.mock.calls.filter(([c]) => c === B)).toHaveLength(1);
	});

	it("still skips a repeat touch of identical long content inside the window", async () => {
		const { service, texts } = await setup();

		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });

		expect(texts()).toEqual([`didOpen:${A}`]);
	});

	// #4532 gap 9 F3: a client that cannot report its record has an UNKNOWN
	// final state, and the pre-#4532 window gate that used to decide for it is
	// the one `GateWindowReopen` proves can leave a server holding no document
	// at all (`formal/lsp-server-content`). So it pushes, every time.
	it("always pushes a client that cannot report the record it holds", async () => {
		const { service, texts } = await setup({ reportRecord: false });

		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });

		expect(texts()).toEqual([`didOpen:${A}`, `didChange:${A}`]);
	});

	// The queue half of the same rule: a record answers what LANDED, and an
	// unknown queue is unknown finality, so it cannot license a skip either.
	it("pushes when a client can report its record but not its queue", async () => {
		const { service, texts } = await setup({ reportQueue: false });

		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });

		expect(texts()).toEqual([`didOpen:${A}`, `didChange:${A}`]);
	});
});

/**
 * #4532 gap 9 F1: the record reports what LANDED. A send of other bytes that
 * the path's queue is still writing lands after a skip, so the server ends on
 * bytes the touch never named — off disk, until the next drift sweep.
 *
 * A real stdio wire cannot be paused, so the transport here is the mock
 * connection (a process boundary) and everything above it is real: the real
 * `LSPService.touchFile`, the real per-document queue, the real notify path.
 * The hold makes "in flight" a fact at the instant the gate reads it, which no
 * socket-based case can promise.
 */
describe("#4532 gap 9 — a skip needs the path's notify queue idle", () => {
	beforeEach(() => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("pushes a touch while a send of other bytes is still in flight", async () => {
		const { service, texts, state } = await setup();
		const touch = { diagnostics: "none" as const, source: "test" };
		await service.touchFile(FILE, A, touch);
		expect(texts()).toEqual([`didOpen:${A}`]);

		// Every didChange write waits at the transport, so the send of B stays in
		// flight for as long as the case needs it to.
		const held: Array<() => void> = [];
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method: string) => {
				if (String(method) === "textDocument/didChange") {
					await new Promise<void>((resolve) => {
						held.push(resolve);
					});
				}
				return undefined;
			},
		);
		// The touch that follows waits on the queue behind B; a short write budget
		// keeps that wait bounded (its own verdict is not what this case asserts).
		vi.stubEnv("PI_LENS_LSP_NOTIFY_BUDGET_MS", "50");
		const entry = await service.getClientForFile(FILE);
		expect(
			entry?.client,
			"the case needs the file's live client",
		).toBeDefined();
		void entry!.client.notify.open(FILE, B, "typescript", undefined, true);

		await service.touchFile(FILE, A, touch);

		for (const resolve of held.splice(0)) resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));

		// The queue is idle and the server holds the bytes the last touch named.
		expect(texts().at(-1)).toBe(`didChange:${A}`);
		expect(state.documentContentHashes.get(FILE)?.hash).toBeDefined();
	});
});
