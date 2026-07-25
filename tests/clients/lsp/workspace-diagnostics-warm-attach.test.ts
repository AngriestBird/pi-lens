import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
let warmAttached = false;
const tryWarmAttachedDiagnostics = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));
vi.mock("../../../clients/warm-attach.js", () => ({
	isWarmAttached: () => warmAttached,
	tryWarmAttachedDiagnostics,
}));

function diagnostic(message: string) {
	return {
		message,
		severity: 1,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		},
	};
}

function makeServer() {
	return {
		id: "typescript",
		name: "typescript",
		extensions: [".ts"],
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

describe("runWorkspaceDiagnostics warm attach sweeps (#822)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tryWarmAttachedDiagnostics.mockReset();
		warmAttached = true;
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-warm-attach-"));
		const server = makeServer();
		getServersForFileWithConfig.mockImplementation((filePath: string) =>
			filePath.endsWith(".ts") ? [server] : [],
		);
	});

	afterEach(() => removeTempDirSync(tmp));

	it("uses incumbent diagnostics without spawning or warming a local client", async () => {
		const files = ["a.ts", "b.ts"].map((name) => path.join(tmp, name));
		for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
		tryWarmAttachedDiagnostics.mockImplementation(async (file: string) => ({
			available: true,
			response: {
				diagnostics: [diagnostic(`attached:${path.basename(file)}`)],
			},
		}));

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const warmup = vi.spyOn(service, "ensureWarmForSweep");
		const results = await service.runWorkspaceDiagnostics(tmp, { files });

		expect(results.map((result) => result.diagnostics[0]?.message)).toEqual([
			"attached:a.ts",
			"attached:b.ts",
		]);
		expect(tryWarmAttachedDiagnostics).toHaveBeenCalledTimes(2);
		expect(tryWarmAttachedDiagnostics).toHaveBeenCalledWith(
			files[0],
			"const x = 1;\n",
			15_000,
			"sweep",
		);
		expect(createLSPClient).not.toHaveBeenCalled();
		expect(warmup).not.toHaveBeenCalled();
	});

	it("promotes after an IPC failure and completes that file and the remainder locally", async () => {
		const files = ["a.ts", "b.ts", "c.ts"].map((name) =>
			path.join(tmp, name),
		);
		for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
		let attachedCalls = 0;
		tryWarmAttachedDiagnostics.mockImplementation(async (file: string) => {
			attachedCalls += 1;
			if (attachedCalls === 1) {
				return {
					available: true,
					response: {
						diagnostics: [diagnostic(`attached:${path.basename(file)}`)],
					},
				};
			}
			warmAttached = false;
			return { available: false, reason: "ipc-error" };
		});
		const localDiagnostic = diagnostic("local");
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "typescript",
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async () => undefined),
			getDiagnostics: vi.fn(() => [localDiagnostic]),
		};
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp, {
			files,
		});

		expect(results.map((result) => result.diagnostics[0]?.message)).toEqual([
			"attached:a.ts",
			"local",
			"local",
		]);
		expect(tryWarmAttachedDiagnostics).toHaveBeenCalledTimes(2);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(warmAttached).toBe(false);
	});
});
