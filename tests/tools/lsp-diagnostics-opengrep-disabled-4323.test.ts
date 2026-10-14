/**
 * #4323: an explicit all-server check (`lens_diagnostics source=lsp`, MCP
 * `pilens_diagnostics`) started Opengrep although the operator had switched it
 * off with `--no-opengrep` or `opengrep.enabled=false`. The write-time runner
 * and `pilens_analyze` already honour the switch; the explicit check selected
 * servers without it.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, the real LSPService
 * and real clients over stdio. Opengrep's command is overridden to a shim that
 * records each start in a marker file and then runs the shared fake server,
 * which answers every pull with one finding. The JSON server is the same fake,
 * answering clean; the YAML server's command points at a missing path, so a
 * primary-only YAML check reaches the clientless `getDiagnostics` fallback.
 *
 * Every switched-off case runs before the control, which starts Opengrep and
 * so proves the fixture would have started it. The host wiring that supplies
 * the flag resolver is pinned in
 * `tests/index-lens-diagnostics-opengrep-flag-4323.test.ts`.
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
const env = setupTestEnvironment("pi-lens-4323-svc-");
// The real path: on macOS the tmpdir is a `/var` -> `/private/var` alias.
const workspace = fs.realpathSync(env.tmpDir);
const probe = path.join(workspace, "probe.json");
const secondProbe = path.join(workspace, "second.json");
const yamlProbe = path.join(workspace, "probe.yaml");
const nested = path.join(workspace, "nested");
const startsMarker = path.join(workspace, "opengrep-starts.txt");
const OPENGREP_FINDING = "opengrep stand-in finding";

/** The operator's switch, as both hosts resolve it. */
const noOpengrep = (name: string) => name === "no-opengrep";

function opengrepStarts(): number {
	if (!fs.existsSync(startsMarker)) return 0;
	return fs.readFileSync(startsMarker, "utf8").split("\n").filter(Boolean)
		.length;
}

async function diagnose(
	params: Record<string, unknown>,
	getFlag?: (name: string) => boolean,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const { getLSPService } = await import("../../clients/lsp/index.js");
	const result = (await createLspDiagnosticsTool(
		undefined,
		undefined,
		getLSPService,
		getFlag ? (name) => getFlag(name) : undefined,
	).execute(
		"probe-4323",
		{ serverScope: "all", waitMs: 3000, ...params },
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

describe("an explicit LSP check with Opengrep switched off (#4323)", () => {
	let service: { shutdown: () => Promise<void> } | undefined;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

	beforeAll(async () => {
		// Never fetch a real yaml-language-server for the missing YAML primary.
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		// Host-boundary stub: the command overrides are project config, which
		// #4248 admits only in a project pi has trusted.
		setProjectTrustState("trusted");
		const shim = (file: string, lines: string[]) => {
			fs.writeFileSync(
				file,
				[
					...lines,
					`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
					"",
				].join("\n"),
			);
		};
		const opengrepShim = path.join(workspace, "opengrep-server.mjs");
		shim(opengrepShim, [
			'import { appendFileSync } from "node:fs";',
			`appendFileSync(${JSON.stringify(startsMarker)}, process.pid + "\\n");`,
			'process.env.FAKE_LSP_RESPOND_PULL_WITH = "items";',
			'process.env.FAKE_LSP_DIAGNOSTIC_SOURCE = "Semgrep";',
			`process.env.FAKE_LSP_DIAGNOSTIC_MESSAGE = ${JSON.stringify(OPENGREP_FINDING)};`,
		]);
		const jsonShim = path.join(workspace, "json-server.mjs");
		shim(jsonShim, ['process.env.FAKE_LSP_RESPOND_PULL_WITH = "empty";']);
		fs.writeFileSync(
			path.join(workspace, "package.json"),
			'{"name":"synthetic-4323-fixture","private":true}\n',
		);
		// Opengrep roots at the nearest `.git` (clients/lsp/server.ts
		// `OpengrepServer`); without one it falls back to this process's cwd.
		fs.mkdirSync(path.join(workspace, ".git"));
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				serverOverrides: {
					json: { command: [process.execPath, jsonShim] },
					yaml: {
						command: [
							path.join(workspace, "missing", "yaml-language-server"),
							"--stdio",
						],
					},
					opengrep: { command: [process.execPath, opengrepShim] },
				},
				disabledServers: ["ast-grep", "typos", "zizmor"],
			}),
		);
		fs.writeFileSync(probe, '{"a": 1}\n');
		fs.writeFileSync(secondProbe, '{"b": 2}\n');
		fs.writeFileSync(yamlProbe, "a: 1\n");
		fs.mkdirSync(nested);
		fs.writeFileSync(path.join(nested, "inner.json"), '{"c": 3}\n');
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-4323-svc-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	});

	it("does not start Opengrep for a single-file check", async () => {
		const result = await diagnose({ path: probe }, noOpengrep);

		expect(opengrepStarts()).toBe(0);
		expect(result.text).not.toContain(OPENGREP_FINDING);
		// The language server still answers; the switch narrows nothing else.
		expect(result.details.unconfirmed).not.toBe(true);
	});

	it("does not start Opengrep for a batch check", async () => {
		const result = await diagnose({ paths: [probe, secondProbe] }, noOpengrep);

		expect(opengrepStarts()).toBe(0);
		expect(result.text).not.toContain(OPENGREP_FINDING);
	});

	it("does not start Opengrep for a directory check", async () => {
		const result = await diagnose({ path: nested }, noOpengrep);

		expect(opengrepStarts()).toBe(0);
		expect(result.text).not.toContain(OPENGREP_FINDING);
	});

	it("does not start Opengrep through the primary-only fallback read", async () => {
		// No YAML server starts, so the touch acquires no client and the tool
		// falls back to an unscoped `getDiagnostics` read.
		const result = await diagnose(
			{ path: yamlProbe, serverScope: "primary" },
			noOpengrep,
		);

		expect(opengrepStarts()).toBe(0);
		expect(result.text).not.toContain(OPENGREP_FINDING);
	});

	it("starts Opengrep and shows its finding when no switch is set", async () => {
		const result = await diagnose({ path: probe });

		expect(opengrepStarts()).toBeGreaterThan(0);
		expect(result.text).toContain(OPENGREP_FINDING);
	});

	it("does not serve an Opengrep finding from a batch cached before the switch", async () => {
		// Without the switch, the batch caches Opengrep's finding for both files.
		const before = await diagnose({ paths: [probe, secondProbe] });
		expect(before.text).toContain(OPENGREP_FINDING);

		// Opengrep is warm now; the switch must still keep it out, and the
		// cached all-server answer must not stand in for the narrower check.
		const after = await diagnose({ paths: [probe, secondProbe] }, noOpengrep);

		expect(after.text).not.toContain(OPENGREP_FINDING);
	});
});
