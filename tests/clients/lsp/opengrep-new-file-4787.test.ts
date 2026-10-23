/**
 * #4787: an auxiliary that advertises fileOperations.didCreate must hear that
 * a file exists before its first didOpen, or opengrep's cached target list
 * answers the first touch as clean.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { setupTestEnvironment, useTrackedTempDirs } from "../test-utils.js";
import { waitFor } from "../interleaving-kit.js";

useTrackedTempDirs("pi-lens-4787-");

describe("opengrep announces a file created after spawn (#4787)", () => {
	let dir: string;
	let proc: Awaited<ReturnType<typeof spawnFakeLspServer>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;

	beforeEach(() => {
		dir = setupTestEnvironment("pi-lens-4787-").tmpDir;
	});

	afterEach(async () => {
		try {
			await client?.shutdown();
		} catch {
			/* the child may already be gone */
		}
		if (proc) await stopLSP(proc).catch(() => {});
		client = undefined;
		proc = undefined;
	});

	it("gets the finding on the first touch of a new file", async () => {
		proc = await spawnFakeLspServer({
			cwd: dir,
			env: {
				...process.env,
				FAKE_LSP_DID_CREATE: "true",
				FAKE_LSP_DID_CREATE_REQUIRED: "1",
			},
		});
		client = await createLSPClient({
			serverId: "opengrep",
			role: "auxiliary",
			process: proc,
			root: dir,
		});

		const file = path.join(dir, "created.py");
		fs.writeFileSync(file, "dangerous_call()\n");
		await client.notify.open(file, fs.readFileSync(file, "utf8"), "python");

		await waitFor(
			() => client?.getDiagnostics(file).length ?? 0,
			(n) => n > 0,
			{
				timeoutMs: 5_000,
			},
		);
		expect(client.getDiagnostics(file)).toEqual([
			expect.objectContaining({
				code: "P4787",
				message: "finding after didCreate",
			}),
		]);
	}, 15_000);
});
