/**
 * #4322: invalid JSON was reported clean when the JSON language server could
 * not start but typos-lsp, an auxiliary spell checker, answered. typos speaks
 * for spelling only; an answer from it says nothing about JSON syntax. The hole
 * is in `LSPService.touchFile`, which the explicit check, pi's write-time LSP
 * runner, warm-attach and re-verification all share: a touch that acquired
 * auxiliaries but no language server still resolved `confirmation:
 * "confirmed"`. A primary-only check reaches the same answer another way: its
 * touch acquires no client, and the `getDiagnostics` fallback acquires typos.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, the real LSPService
 * and the real client over a stdio JSON-RPC wire. The JSON server's command is
 * overridden to a path that does not exist, the reporter's reproduction; typos
 * is overridden to the shared fake server, which answers a pull with one
 * finding, or none for content carrying its `fake-lsp-clean` marker.
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
import { makeRunnerCtx } from "../support/runner-ctx.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-4322-svc-");
// The real path: on macOS the tmpdir is a `/var` -> `/private/var` alias, and
// an adopted root is compared against the classifier's realpath.
const workspace = fs.realpathSync(env.tmpDir);
const probe = path.join(workspace, "probe.json");
const secondProbe = path.join(workspace, "second.json");
const TYPOS_FINDING = "typos stand-in finding";

async function diagnose(
	serverScope: "primary" | "all",
	target: { path: string } | { paths: string[] } = { path: probe },
): Promise<{
	text: string;
	details: Record<string, unknown>;
}> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4322",
		{ ...target, serverScope, waitMs: 3000 },
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

describe("a JSON file whose language server cannot start (#4322)", () => {
	let service: { shutdown: () => Promise<void> } | undefined;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

	beforeAll(async () => {
		// Never fetch a real vscode-json-language-server for the missing primary.
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		// Host-boundary stub: the command overrides are project config, which
		// #4248 admits only in a project pi has trusted.
		setProjectTrustState("trusted");
		const typosShim = path.join(workspace, "typos-server.mjs");
		fs.writeFileSync(
			typosShim,
			[
				// typos answers every pull: one finding, or none for content that
				// carries the fake's `fake-lsp-clean` marker.
				'process.env.FAKE_LSP_DIAGNOSTIC_SOURCE = "typos";',
				`process.env.FAKE_LSP_DIAGNOSTIC_MESSAGE = ${JSON.stringify(TYPOS_FINDING)};`,
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(workspace, "package.json"),
			'{"name":"synthetic-json-fixture","private":true}\n',
		);
		// typos roots at the nearest `.git` (clients/lsp/server.ts `TyposServer`);
		// without one it falls back to this process's cwd, outside the workspace.
		fs.mkdirSync(path.join(workspace, ".git"));
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				serverOverrides: {
					json: {
						command: [
							path.join(workspace, "missing", "json-language-server"),
							"--stdio",
						],
					},
					typos: { command: [process.execPath, typosShim] },
				},
				disabledServers: ["ast-grep", "opengrep", "zizmor"],
			}),
		);
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-4322-svc-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	});

	it("does not report invalid JSON clean on typos' clean answer alone", async () => {
		// Invalid JSON that typos answers clean for.
		fs.writeFileSync(probe, '{"fake-lsp-clean": }\n');

		const result = await diagnose("all");

		expect(result.details.unconfirmed).toBe(true);
		expect(result.details.primaryUnavailable).toContain("Primary LSP (json)");
		expect(result.text).toContain("Primary LSP (json): not available");
		expect(result.text).not.toContain("confirmed clean");
		// A server that never started is not a check that ran out of time.
		expect(result.details.timedOut).not.toBe(true);
	}, 30_000);

	it("names the missing language server in a batch check", async () => {
		fs.writeFileSync(probe, '{"fake-lsp-clean": }\n');
		fs.writeFileSync(secondProbe, '{"fake-lsp-clean": 1,}\n');

		const result = await diagnose("all", { paths: [probe, secondProbe] });

		expect(result.text).toContain(
			"0 files confirmed clean, 2 unconfirmed: 2 with no language server " +
				"answer (it could not be started, or was still starting).",
		);
	}, 30_000);

	it("still shows typos' findings while the JSON check is unavailable", async () => {
		fs.writeFileSync(probe, '{"probe": }\n');

		const result = await diagnose("all");

		// typos really answered for this file: its finding is delivered.
		expect(result.details.auxiliaryDiagnosticsCount).toBe(1);
		expect(result.text).toContain(TYPOS_FINDING);
		expect(result.details.unconfirmed).toBe(true);
		expect(result.text).toContain("Primary LSP (json): not available");
	}, 30_000);

	it("does not report the primary-only check clean when no language server ran", async () => {
		fs.writeFileSync(probe, '{"fake-lsp-clean":"valid"}\n');

		const result = await diagnose("primary");

		expect(result.details.unconfirmed).toBe(true);
		expect(result.text).toContain("Primary LSP (json): not available");
		expect(result.text).not.toContain("confirmed clean");
	}, 30_000);

	it("pi's write-time LSP runner does not report the file as checked clean", async () => {
		// The dispatch runner's own touch (`with-auxiliary`), not the tool's.
		const { default: lspRunner } =
			await import("../../clients/dispatch/runners/lsp.js");
		fs.writeFileSync(probe, '{"fake-lsp-clean": }\n');

		const clean = await lspRunner.run(
			makeRunnerCtx(probe, workspace, { kind: "json" }),
		);
		expect(clean.status).toBe("skipped");

		fs.writeFileSync(probe, '{"probe": }\n');
		const withFinding = await lspRunner.run(
			makeRunnerCtx(probe, workspace, { kind: "json" }),
		);
		// typos' finding is kept, and the result names the missing language server.
		expect(withFinding.diagnostics.map((d) => d.message)).toEqual([
			expect.stringContaining(TYPOS_FINDING),
		]);
		expect(withFinding.unconfirmedServerIds).toContain("json");
	}, 30_000);
});
