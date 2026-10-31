// flake-shape: service-double — #5040: a language server is a spawned process, and this file's subject
// is that it publishes for an importer BEFORE the exporter edit and then stays silent, which no real
// server can be asked to do on demand
// flake-shape: in-process-mock — the client, the graph edges the cascade walks, the logger the cell
// reads back and the quiet-window scheduler stand in; the service, the notify-skip gate, the merge, the
// confirmed-touch read and the run verdict are the real production code
/**
 * #5040: a push-only server's cached importer answer must not read as a
 * confirmed clean after its exporter changed.
 *
 * Recurrence this file prevents: jdtls 1.63.0 publishes for one importer of an
 * edited exporter and never for another (PR #5035's wire capture), so the
 * cascade's touch of the silent importer sent nothing (`shouldSkipNotify` —
 * unchanged content), waited, and read the answer the server had published
 * BEFORE the edit. `isConfirmedTouch` had no age axis, so the run reported
 * `clean` for a dependent no server had re-checked since the exporter changed.
 *
 * Two layers, both through production code:
 *
 *   - `LSPService.touchFile` (the real one) against a fake language-server
 *     client: what the touch reports about the answer it reused, or did not.
 *   - `computeCascadeForFile` (the real one) over the same real service: the
 *     run that read `clean` before this fix, and the run that still reads
 *     `clean` because the server DID answer inside the touch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import type { ReviewGraph } from "../../clients/review-graph/types.js";
import { setupTestEnvironment } from "./test-utils.js";
import { installLspService } from "../support/lsp-service-seam.js";

const mocks = vi.hoisted(() => ({
	createLSPClient: vi.fn(),
	getServersForFileWithConfig: vi.fn(),
	buildOrUpdateGraph: vi.fn(),
	computeImpactCascade: vi.fn(),
	computeTransitiveImpact: vi.fn(),
	formatImpactCascade: vi.fn(),
	logCascade: vi.fn(),
}));

vi.mock("../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/client.js")>()),
	createLSPClient: mocks.createLSPClient,
}));

// The review graph is another subsystem: its file-level edges are the fixture
// below, and the cascade's own neighbour walk is what this file proves.
vi.mock("../../clients/review-graph/service.js", () => ({
	buildOrUpdateGraph: mocks.buildOrUpdateGraph,
	computeImpactCascade: mocks.computeImpactCascade,
	computeTransitiveImpact: mocks.computeTransitiveImpact,
	formatImpactCascade: mocks.formatImpactCascade,
}));

vi.mock("../../clients/cascade-logger.js", () => ({
	logCascade: mocks.logCascade,
	flushCascadeLog: vi.fn().mockResolvedValue(undefined),
	getCascadeLogPath: vi.fn().mockReturnValue("/tmp/cascade.log"),
}));

// The quiet window owns a scheduler the unit lane must not arm.
vi.mock("../../clients/quiet-window.js", () => ({
	registerQuietWindowTask: vi.fn(),
}));

const NEIGHBOR_CONTENT = "package main\n\nfunc main() {}\n";

/**
 * A push-only language server that publishes ONLY when it decides to, like
 * jdtls holding a clean importer: `publish()` is the server's own decision (the
 * fixture asks for it, or the server re-checks on its own during a wait), and
 * `notify.open`/`change` only record that the server was sent the bytes — a
 * real jdtls publishes for an importer when its project model changes, not on
 * every didOpen.
 */
function makePushOnlyServer(options: { serverId?: string; filePath: string }) {
	const key = normalizeMapKey(options.filePath);
	const state = {
		diags: [] as unknown[],
		publishedAt: 0,
		version: 0,
		sentContent: undefined as string | undefined,
		notifies: [] as string[],
		/** The push wait stays open until the case releases it, so only a
		 *  command or the #707 racer can answer. */
		holdWait: false,
		/** The server re-checks the file on its own while a wait is open. */
		publishOnWait: false,
	};
	const publish = (diags: unknown[], publishedAt: number): void => {
		state.diags = diags;
		state.publishedAt = publishedAt;
		state.version += 1;
	};
	// A released-on-teardown hold: the case owns the settle, so no test leaves a
	// pending wait for the next one and no handle is kept alive.
	let releaseWait: () => void = () => {};
	const heldWait = new Promise<void>((resolve) => {
		releaseWait = resolve;
	});
	const client: Record<string, unknown> = {
		serverId: options.serverId ?? "gopls",
		root: path.dirname(options.filePath),
		customServer: false,
		isAlive: () => true,
		wasShutdownIntentional: () => true,
		getExitedAt: () => undefined,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		getSaveOptions: () => ({ includeText: false }),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		getLaunchVariant: () => undefined,
		get diagnosticsVersion() {
			return state.version;
		},
		getDiagnosticsVersionForPath: () => state.version,
		// #5040: the accessor this fix adds — the publish stamp behind the cached
		// answer, without building the client's whole per-file map.
		getDiagnosticsPublishedAt: () =>
			state.publishedAt > 0 ? state.publishedAt : undefined,
		getDiagnostics: () => state.diags,
		getDiagnosticBinding: () => undefined,
		getAllDiagnostics: () =>
			state.publishedAt > 0
				? new Map([[key, { diags: state.diags, ts: state.publishedAt }]])
				: new Map(),
		getTrackedDiagnosticPaths: () =>
			state.publishedAt > 0 ? [options.filePath] : [],
		pruneDiagnostics: () => 0,
		waitForDiagnostics: vi.fn(async () => {
			if (state.publishOnWait) {
				state.publishOnWait = false;
				publish([], Date.now());
			}
			if (state.holdWait) await heldWait;
		}),
		pingLiveness: async () => true,
		getSentContent: () =>
			state.sentContent === undefined ? undefined : { hash: state.sentContent },
		hasNotifyInFlight: () => false,
		notify: {
			open: vi.fn(async (_filePath: string, content: string) => {
				state.notifies.push("open");
				state.sentContent = hashDiagnosticContent(content);
			}),
			change: vi.fn(async (_filePath: string, content: string) => {
				state.notifies.push("change");
				state.sentContent = hashDiagnosticContent(content);
			}),
			save: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
			announceCreated: () => undefined,
		},
	};
	return {
		client,
		state,
		publish,
		releaseWait: () => releaseWait(),
	};
}

function serverConfig(
	serverId: string,
	root: string,
	extension: string,
): Record<string, unknown> {
	return {
		id: serverId,
		name: serverId,
		extensions: [extension],
		idleEviction: "resident",
		root: async () => root,
		spawn: vi.fn(async () => ({
			process: {
				killed: false,
				kill: vi.fn(),
				on: vi.fn(),
				removeListener: vi.fn(),
			},
			source: "test",
		})),
	};
}

function emptyGraph(): ReviewGraph {
	return {
		version: "test",
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

/** A neighbour edge with no changed symbols, so no `references()` upgrade runs. */
function impact(filePath: string, neighbors: string[]) {
	return {
		filePath,
		changedSymbols: [] as string[],
		directImporters: neighbors,
		directCallers: [] as string[],
		neighborFiles: neighbors,
		riskFlags: [] as string[],
	};
}

const TOUCH_OPTIONS = {
	diagnostics: "document" as const,
	collectDiagnostics: true,
	clientScope: "primary" as const,
	source: "test-5040",
};

/**
 * One fixture for every case: a real `LSPService` over the fake server, the
 * importer's answer published while the exporter is intact, and one touch that
 * taught the server these exact bytes (so the next touch skips its notify,
 * which is the production shape this defect needs).
 */
async function setupServer(options: {
	prefix: string;
	serverId?: string;
	extension?: string;
	publishPreEdit?: boolean;
}) {
	const env = setupTestEnvironment(options.prefix);
	const serverId = options.serverId ?? "gopls";
	const importer = path.join(env.tmpDir, "C.go");
	fs.writeFileSync(importer, NEIGHBOR_CONTENT);
	const server = makePushOnlyServer({ serverId, filePath: importer });
	if (options.publishPreEdit !== false) {
		// The answer the server computed BEFORE the exporter edit: its own stamp,
		// a minute old, and it never republishes for this importer on its own.
		server.publish([], Date.now() - 60_000);
	}
	mocks.createLSPClient.mockResolvedValue(server.client);
	mocks.getServersForFileWithConfig.mockReturnValue([
		serverConfig(serverId, env.tmpDir, options.extension ?? ".go"),
	]);
	const { LSPService } = await import("../../clients/lsp/index.js");
	const service = new LSPService();
	// The first touch sends the bytes; a later touch of the same content skips.
	await service.touchFile(importer, NEIGHBOR_CONTENT, TOUCH_OPTIONS);
	return { env, serverId, importer, server, service };
}

beforeEach(async () => {
	vi.resetModules();
	mocks.createLSPClient.mockReset();
	mocks.getServersForFileWithConfig.mockReset();
	mocks.buildOrUpdateGraph.mockReset().mockResolvedValue(emptyGraph());
	mocks.computeImpactCascade.mockReset();
	mocks.computeTransitiveImpact.mockReset().mockReturnValue({
		seedFile: "",
		hits: [],
		truncated: false,
		maxDepthReached: 0,
	});
	mocks.formatImpactCascade.mockReset().mockReturnValue("impact header");
	mocks.logCascade.mockReset();
	// #4709: the module setter belongs to one module copy, so it is armed after
	// the reset, for every case.
	(await import("../../clients/lsp/config.js"))._setServersForFileForTests(
		mocks.getServersForFileWithConfig,
	);
});

describe("touchFile reports the cached answer it reused (#5040)", () => {
	it("names the server and the publish stamp of an answer it never refreshed", async () => {
		const { env, importer, server, service } = await setupServer({
			prefix: "cascade-reused-answer-",
		});
		try {
			const preEditPublishedAt = server.state.publishedAt;
			const result = await service.touchFile(
				importer,
				NEIGHBOR_CONTENT,
				TOUCH_OPTIONS,
			);

			expect(result).toBeDefined();
			// Nothing was pushed this time: the server already holds these bytes
			// (`shouldSkipNotify`), so its cache entry is the whole answer.
			expect(server.state.notifies).toEqual(["open"]);
			expect(result?.diags).toEqual([]);
			expect(result?.inconclusive).toBeFalsy();
			expect(result?.confirmation).toBe("confirmed");
			expect(result?.reusedAnswer).toEqual({
				serverId: "gopls",
				publishedAt: preEditPublishedAt,
			});
		} finally {
			env.cleanup();
		}
	});

	it("reports no reused answer when the server published inside the touch", async () => {
		const { env, importer, server, service } = await setupServer({
			prefix: "cascade-reused-answer-publish-",
		});
		try {
			// The server re-checks the importer on its own while the touch waits,
			// so the answer this touch reports is its own.
			server.state.publishOnWait = true;

			const result = await service.touchFile(
				importer,
				NEIGHBOR_CONTENT,
				TOUCH_OPTIONS,
			);

			expect(server.state.notifies).toEqual(["open"]);
			expect(result?.diags).toEqual([]);
			expect(result?.reusedAnswer).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("reports no reused answer for the #707 sync confirm, which is not a cached observation", async () => {
		process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS = "25";
		const { env, importer, server, service } = await setupServer({
			prefix: "cascade-reused-answer-sync-",
			serverId: "typescript",
		});
		try {
			// The pre-edit cache entry says clean; the sync command answers this
			// touch, and its answer is not a cached observation at all. The push
			// wait is held so only the command can settle it (classic tsserver).
			server.client.getAdvertisedCommands = () => [
				"typescript.tsserverRequest",
			];
			server.client.executeCommand = vi.fn(async () => ({
				executed: true,
				result: { success: true, body: [] },
			}));
			server.state.holdWait = true;

			const result = await service.touchFile(
				importer,
				NEIGHBOR_CONTENT,
				TOUCH_OPTIONS,
			);

			expect(server.client.executeCommand).toHaveBeenCalled();
			expect(result?.diags).toEqual([]);
			expect(result?.reusedAnswer).toBeUndefined();
		} finally {
			server.releaseWait();
			delete process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS;
			env.cleanup();
		}
	});

	// The documented fall-through: a client that cannot date its cached answer
	// keeps today's verdict, exactly as a missing `binding` reads "unknown"
	// rather than demoted.
	it("reports no reused answer for a client that cannot date its cache", async () => {
		const { env, importer, server, service } = await setupServer({
			prefix: "cascade-reused-answer-unknown-",
		});
		try {
			delete server.client.getDiagnosticsPublishedAt;

			const result = await service.touchFile(
				importer,
				NEIGHBOR_CONTENT,
				TOUCH_OPTIONS,
			);

			expect(result?.reusedAnswer).toBeUndefined();
			expect(result?.confirmation).toBe("confirmed");
		} finally {
			env.cleanup();
		}
	});
});

describe("the cascade does not read a pre-edit answer as this edit's clean", () => {
	/**
	 * The production sequence: the importer's clean answer is published while the
	 * exporter is intact, the exporter is edited, and the cascade asks the
	 * importer again. The only difference between the cases is whether the server
	 * answers inside the cascade's touch.
	 */
	async function runCascade(options: { publishInsideTouch: boolean }) {
		const env = setupTestEnvironment("cascade-pre-edit-answer-");
		const exporter = path.join(env.tmpDir, "B.go");
		const importer = path.join(env.tmpDir, "C.go");
		fs.writeFileSync(exporter, "package main\n\nfunc Lib() {}\n");
		fs.writeFileSync(importer, NEIGHBOR_CONTENT);
		mocks.computeImpactCascade.mockReturnValue(impact(exporter, [importer]));

		const server = makePushOnlyServer({ filePath: importer });
		// The answer a jdtls-class server publishes for the importer BEFORE the
		// edit, and then never republishes for it on its own.
		server.publish([], Date.now() - 60_000);
		mocks.createLSPClient.mockResolvedValue(server.client);
		mocks.getServersForFileWithConfig.mockReturnValue([
			serverConfig("gopls", env.tmpDir, ".go"),
		]);

		const { LSPService } = await import("../../clients/lsp/index.js");
		const service = new LSPService();
		installLspService(service);
		// The importer was read once before the edit, which is what makes the
		// cascade's touch of it a notify-skipped one.
		await service.touchFile(importer, NEIGHBOR_CONTENT, TOUCH_OPTIONS);
		// Armed AFTER the pre-edit read, so it is the cascade's own touch the
		// server answers.
		if (options.publishInsideTouch) {
			server.state.publishOnWait = true;
		}
		const { computeCascadeForFile } =
			await import("../../clients/dispatch/integration.js");

		// The exporter edit: the change the importer's answer predates.
		fs.writeFileSync(exporter, "package main\n\nfunc Lib(a string) {}\n");
		const run = await computeCascadeForFile(exporter, env.tmpDir, {
			turnSeq: 1,
			writeSeq: 1,
		});
		return { env, run, importer, server };
	}

	it("reads a neighbour whose cached answer predates the edit as unconfirmed, never clean", async () => {
		const { env, run, importer, server } = await runCascade({
			publishInsideTouch: false,
		});
		try {
			// The server never answered this edit for the importer.
			expect(server.state.notifies).toEqual(["open"]);
			expect(run.skipReason).toBe("indeterminate");
			expect(run.result).toBeUndefined();
			expect(run.unconfirmed?.servers).toEqual([
				{
					serverId: "gopls",
					reason: "pre-edit-answer",
					waitMs: 0,
					paths: [importer],
				},
			]);
			expect(run.observedNeighborPaths).toBeUndefined();
			// The decision is recorded on cascade.log, not only implied by the run.
			const touchRow = mocks.logCascade.mock.calls
				.map((args) => args[0] as { phase?: string; metadata?: unknown })
				.filter((row) => row?.phase === "neighbor_touch")
				.at(-1);
			expect(touchRow?.metadata).toMatchObject({
				preEditAnswer: true,
				answerServerId: "gopls",
			});
		} finally {
			env.cleanup();
		}
	});

	it("still reads a neighbour clean when the server answered inside the touch", async () => {
		const { env, run, importer } = await runCascade({
			publishInsideTouch: true,
		});
		try {
			expect(run.skipReason).toBe("clean");
			expect(run.unconfirmed).toBeUndefined();
			expect(run.observedNeighborPaths).toEqual([importer]);
		} finally {
			env.cleanup();
		}
	});

	it("records the pre-edit answer in the degradation ledger", async () => {
		const { env, run } = await runCascade({ publishInsideTouch: false });
		try {
			const { getDegradationSummary } =
				await import("../../clients/degradation-ledger.js");
			const kinds = getDegradationSummary().map((entry) => entry.kind);
			expect(kinds).toContain("cascade-pre-edit-answer");
			expect(run.skipReason).toBe("indeterminate");
		} finally {
			env.cleanup();
		}
	});
});
