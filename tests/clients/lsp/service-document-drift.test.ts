/**
 * #1783 — the disk-drift backstop, end to end through LSPService.
 *
 * Reproduces the 2026-08-20 dogfood forensics: a file is opened through the
 * normal sync path, then a bash-tool bulk edit rewrites it on disk. No
 * `didChange` is sent, so the server keeps answering from the pre-edit
 * content. Before the fix nothing ever compared disk against what the server
 * holds, and the stale view survived for the life of the server.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeFakeProcess() {
	return {
		process: { killed: false, kill: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
		stderr: { on: vi.fn(), off: vi.fn() },
		pid: 999,
	};
}

function makeServer(root: string) {
	return {
		id: "typescript",
		name: "typescript",
		extensions: [".ts"],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

/**
 * A client that remembers the LAST content it was given — the fake stand-in
 * for the language server's in-memory document view.
 */
function makeClient(openDocuments: Set<string>) {
	const received: string[] = [];
	return {
		received,
		serverId: "typescript",
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		isDocumentOpen: (filePath: string) => openDocuments.has(path.resolve(filePath)),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none" as const,
		}),
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		diagnosticsVersion: 0,
		getDiagnostics: vi.fn(() => []),
		notify: {
			open: vi.fn(async (filePath: string, content: string) => {
				openDocuments.add(path.resolve(filePath));
				received.push(content);
			}),
			change: vi.fn(async () => {}),
			watchedFileChange: vi.fn(),
		},
		waitForDiagnostics: vi.fn(async () => undefined),
	};
}

const ORIGINAL = "export const answer = 42;\nconst unused = 1;\n";
/** Longer than ORIGINAL: the size half of the drift key moves. */
const BULK_EDITED = "export const answer = 42;\nexport const extra = 7;\n";

describe("LSPService disk-drift backstop (#1783)", () => {
	let dir: string;
	let file: string;

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-drift-"));
		file = path.join(dir, "stdio.ts");
		await fs.writeFile(file, ORIGINAL, "utf-8");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function primeService() {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const openDocuments = new Set<string>();
		const client = makeClient(openDocuments);
		getServersForFileWithConfig.mockReturnValue([makeServer(dir)]);
		createLSPClient.mockResolvedValue(client);
		// The normal sync path: content read from disk, pushed to the server.
		await service.touchFile(file, ORIGINAL, {
			diagnostics: "none",
			clientScope: "primary",
			source: "lsp_sync",
		});
		expect(client.received).toEqual([ORIGINAL]);
		return { service, client };
	}

	/** The untracked bulk edit: content, size and mtime all move on disk. */
	async function bulkEditOnDisk(content = BULK_EDITED) {
		await fs.writeFile(file, content, "utf-8");
		const future = new Date(Date.now() + 5_000);
		await fs.utimes(file, future, future);
	}

	it("resynchronizes a document a bash bulk edit moved behind the server", async () => {
		const { service, client } = await primeService();

		await bulkEditOnDisk();
		// The stale state the forensics captured: the server's view is pre-edit
		// and no notification carried the new bytes.
		expect(client.received).toEqual([ORIGINAL]);

		const result = await service.sweepDocumentDrift({ force: true });

		expect(result?.candidates).toBe(1);
		expect(result?.resynced).toBe(1);
		expect(client.received).toEqual([ORIGINAL, BULK_EDITED]);
	});

	it("emits a bounded record naming the file and the drift age", async () => {
		const { service } = await primeService();
		const { getDegradationSummary, resetDegradationLedger } = await import(
			"../../../clients/degradation-ledger.js"
		);
		resetDegradationLedger();

		await bulkEditOnDisk();
		await service.sweepDocumentDrift({ force: true });

		const summary = getDegradationSummary();
		const group = summary.find((entry) => entry.kind === "lsp-document-drift");
		expect(group).toBeDefined();
		expect(
			group?.latestReasons.some((e) => e.subject.endsWith("stdio.ts")),
		).toBe(true);
		expect(
			group?.latestReasons.some((e) => /untracked disk drift/.test(e.reason)),
		).toBe(true);
	});

	it("re-stamps without notifying when the mtime moved but the bytes did not", async () => {
		const { service, client } = await primeService();

		const future = new Date(Date.now() + 5_000);
		await fs.utimes(file, future, future);

		const result = await service.sweepDocumentDrift({ force: true });

		expect(result?.candidates).toBe(1);
		expect(result?.unchanged).toBe(1);
		expect(result?.resynced).toBe(0);
		// The distinction the ledger must preserve: touched is not changed.
		expect(client.received).toEqual([ORIGINAL]);
	});

	it("never resyncs a document no live client still holds open", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const openDocuments = new Set<string>();
		const client = makeClient(openDocuments);
		getServersForFileWithConfig.mockReturnValue([makeServer(dir)]);
		createLSPClient.mockResolvedValue(client);
		await service.touchFile(file, ORIGINAL, {
			diagnostics: "none",
			clientScope: "primary",
			source: "lsp_sync",
		});
		// The server closed the document (eviction, shutdown, rename).
		openDocuments.clear();

		await bulkEditOnDisk();
		const result = await service.sweepDocumentDrift({ force: true });

		expect(result?.unheld).toBe(1);
		expect(result?.resynced).toBe(0);
		expect(client.received).toEqual([ORIGINAL]);
	});

	it("fires the sweep from touchFile, so no explicit call is needed", async () => {
		const previous = process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
		process.env.PI_LENS_LSP_DRIFT_CHECK_MS = "1";
		try {
			const { service, client } = await primeService();
			await bulkEditOnDisk();
			// A touch of ANOTHER file is enough: the backstop is not keyed to the
			// file being touched.
			const other = path.join(dir, "other.ts");
			await fs.writeFile(other, "export const x = 1;\n", "utf-8");
			await service.touchFile(other, "export const x = 1;\n", {
				diagnostics: "none",
				clientScope: "primary",
				source: "lsp_sync",
			});
			// The sweep is deliberately not awaited by touchFile; drain the
			// microtask/IO turns it needs.
			await vi.waitFor(() => {
				expect(client.received).toContain(BULK_EDITED);
			});
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
			else process.env.PI_LENS_LSP_DRIFT_CHECK_MS = previous;
		}
	});
});
