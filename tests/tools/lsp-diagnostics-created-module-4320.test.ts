/**
 * #4320: with Pyrefly 1.3.2 an already-running session kept reporting
 * `missing-import` for `from pkg.new_module import f` after `new_module.py` was
 * created, in both `pilens_diagnostics` and `pilens_lsp_navigation`. A fresh
 * server resolved it. Two layers held the stale answer:
 *
 *  1. the server: it caches the failed lookup and only a watched-files
 *     Created (1) clears it, but the client announced every file that existed
 *     at open time as Changed (2);
 *  2. the persisted workspace-diagnostics cache: it replayed the importer's
 *     finding because the importer's bytes and its known imports never changed.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, the real LSPService and
 * the real client over a stdio JSON-RPC wire. The server is the shared fake in
 * its `FAKE_LSP_STALE_MODULE_LOOKUP` profile: it models Pyrefly's measured
 * behaviour (failed lookup cached, cleared only by Created), launched as a
 * project-configured custom server. No pi write is involved: the module is
 * created straight on disk, the reporter's isolated reproduction.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-4320-svc-");
const workspace = env.tmpDir;

const IMPORTER = 'import "./new_module"\nlocal value = 1\n';

async function diagnose(paths: string[]): Promise<{
	text: string;
	details: Record<string, unknown>;
}> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4320",
		{ paths, serverScope: "primary", waitMs: 3000, concurrency: 1 },
		undefined,
		null,
		{ cwd: workspace },
	)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return {
		text: String(result.content[0]?.text),
		details: result.details ?? {},
	};
}

describe("a module created after the server started (#4320)", () => {
	let service: { shutdown: () => Promise<void> } | undefined;

	beforeAll(async () => {
		// Host-boundary stub: the fixture launches a project-configured server in a
		// project pi has trusted (#4248 refuses it otherwise).
		setProjectTrustState("trusted");
		const shim = path.join(workspace, "stale-lookup-server.mjs");
		fs.writeFileSync(
			shim,
			[
				// A push-only server, Pyrefly's measured shape here.
				'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
				'process.env.FAKE_LSP_STALE_MODULE_LOOKUP = "1";',
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		fs.writeFileSync(path.join(workspace, ".luarc.json"), "{}\n");
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					emmylua: {
						name: "stale lookup server",
						extensions: [".lua"],
						command: process.execPath,
						args: [shim],
						rootMarkers: [".luarc.json"],
					},
				},
				disabledServers: ["lua"],
			}),
		);
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-4320-svc-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
	});

	it("clears the importer's missing-import without a restart, and still reports a module that never appears", async () => {
		const importer = path.join(workspace, "probe.lua");
		const orphan = path.join(workspace, "orphan.lua");
		fs.writeFileSync(importer, IMPORTER);
		fs.writeFileSync(orphan, 'import "./never_exists"\nlocal value = 2\n');

		// Step 2 of the issue: both imports are missing.
		const before = await diagnose([importer, orphan]);
		expect(before.details.primaryDiagnosticsCount).toBe(2);

		// Step 3: the module appears on disk. No pi write, no restart.
		const created = path.join(workspace, "new_module.lua");
		fs.writeFileSync(created, "return {}\n");

		// Step 4: the same active diagnostics, new module first.
		const after = await diagnose([created, importer, orphan]);

		expect(after.text).toContain("never_exists");
		expect(after.text).not.toContain("Cannot find module new_module");
		// Exactly the module that never appears is still reported.
		expect(after.details.primaryDiagnosticsCount).toBe(1);
	}, 30_000);
});
