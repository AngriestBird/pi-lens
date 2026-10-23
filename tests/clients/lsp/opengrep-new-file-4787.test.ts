/**
 * #4787: an auxiliary that advertises fileOperations.didCreate must hear that
 * a file exists before its first didOpen, or opengrep's cached target list
 * answers the first touch as clean.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { waitFor } from "../interleaving-kit.js";
import { setupTestEnvironment, useTrackedTempDirs } from "../test-utils.js";

useTrackedTempDirs("pi-lens-4787-");

describe("opengrep announces a file created after spawn (#4787)", () => {
	let dir: string;
	let proc: Awaited<ReturnType<typeof spawnFakeLspServer>> | undefined;
	let service: LSPService | undefined;

	beforeEach(() => {
		dir = setupTestEnvironment("pi-lens-4787-").tmpDir;
		service = new LSPService();
	});

	afterEach(async () => {
		await service?.shutdown({ fast: true }).catch(() => {});
		if (proc) await stopLSP(proc).catch(() => {});
		service = undefined;
		proc = undefined;
		_setServersForFileForTests(undefined);
	});

	it("gets the finding on the first touch of a new file", async () => {
		proc = await spawnFakeLspServer({
			cwd: dir,
			env: {
				...process.env,
				FAKE_LSP_DID_CREATE: "true",
				FAKE_LSP_DID_CREATE_REQUIRED: "1",
				FAKE_LSP_IGNORE_PULL: "1",
			},
		});
		const server = {
			id: "opengrep",
			name: "opengrep",
			role: "auxiliary" as const,
			extensions: [".py"],
			idleEviction: "resident" as const,
			root: async () => dir,
			spawn: async () => ({ process: proc!, source: "direct" as const }),
		};
		_setServersForFileForTests(() => [server]);

		const existing = path.join(dir, "existing.py");
		fs.writeFileSync(existing, "safe_call()\n");
		await service!.getClientForFile(existing);
		const file = path.join(dir, "created.py");
		fs.writeFileSync(file, "dangerous_call()\n");
		await service!.touchFile(file, fs.readFileSync(file, "utf8"), {
			clientScope: "all",
			collectDiagnostics: true,
			diagnostics: "document",
			source: "test",
		});
		const readDiagnostics = () =>
			[
				...(
					service as unknown as {
						state: {
							clients: Map<
								string,
								{ getDiagnostics: (filePath: string) => unknown[] }
							>;
						};
					}
				).state.clients.values(),
			].flatMap((client) => client.getDiagnostics(file));
		await waitFor(readDiagnostics, (diags) => diags.length > 0, {
			timeoutMs: 5_000,
		});
		expect(readDiagnostics()).toEqual([
			expect.objectContaining({
				code: "P4787",
				message: "finding after didCreate",
			}),
		]);
	}, 15_000);

	it("does not announce a file to a server without didCreate", async () => {
		proc = await spawnFakeLspServer({
			cwd: dir,
			env: {
				...process.env,
				FAKE_LSP_DID_CREATE_REQUIRED: "1",
				FAKE_LSP_IGNORE_PULL: "1",
			},
		});
		const server = {
			id: "opengrep",
			name: "opengrep",
			role: "auxiliary" as const,
			extensions: [".py"],
			idleEviction: "resident" as const,
			root: async () => dir,
			spawn: async () => ({ process: proc!, source: "direct" as const }),
		};
		_setServersForFileForTests(() => [server]);

		const existing = path.join(dir, "existing.py");
		fs.writeFileSync(existing, "safe_call()\n");
		await service!.getClientForFile(existing);
		const file = path.join(dir, "created.py");
		fs.writeFileSync(file, "dangerous_call()\n");
		const result = await service!.touchFile(
			file,
			fs.readFileSync(file, "utf8"),
			{
				clientScope: "all",
				collectDiagnostics: true,
				diagnostics: "document",
				source: "test",
			},
		);

		expect(result?.diags ?? []).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "P4787" })]),
		);
	}, 15_000);
});
