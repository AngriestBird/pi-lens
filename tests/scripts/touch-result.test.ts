/**
 * #4403: the LSP scripts' one reading of a touch (scripts/lib/touch-result.mjs)
 * takes a touch that no language server answered as "no client ready", a
 * disabled primary included, and a wrapped answer as an answer.
 *
 * Recurrences:
 * - Since PR #4411, `touchFile` returns the `primary-unavailable` verdict with
 *   no diagnostics, not `undefined`, when the operator disabled a primary and
 *   nothing else answered. The smoke handshake lane read that as an answer, so
 *   PR #4450's handshake job failed the official Docker row ("expected
 *   alternate docker-official, got no warm client") on a runner without the
 *   binary, where it had reported the row unavailable.
 * - Since #1179 the answer is a `{ diags }` wrapper; bench-lsp still tested
 *   `Array.isArray` and reported every installed server unavailable.
 *
 * The real LSPService with the smoke row's own touch options. The official
 * Docker server's command is a project override: a path that does not exist,
 * or the shared fake server.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { touchAnsweredDiagnostics } from "../../scripts/lib/touch-result.mjs";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const PREFIX = "pi-lens-4403-smoke-";

type TouchResult = Parameters<typeof touchAnsweredDiagnostics>[0];
type Service = {
	touchFile: (
		file: string,
		content: string,
		options: Record<string, unknown>,
	) => Promise<TouchResult>;
	getWarmClientForFile: (
		file: string,
	) => Promise<{ info: { id: string } } | undefined>;
	shutdown: () => Promise<void>;
};
let service: Service | undefined;
const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

/**
 * The `dockerfile-official` row's workspace: `docker` off in
 * `lsp.disabledServers` (as the row writes it), the official server's command
 * overridden, and typos as a fake auxiliary.
 */
async function dockerfileRow(official: "missing" | "fake") {
	const workspace = fs.realpathSync(setupTestEnvironment(PREFIX).tmpDir);
	fs.mkdirSync(path.join(workspace, ".git"));
	fs.mkdirSync(path.join(workspace, ".pi-lens"));
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				"docker-official": {
					command:
						official === "missing"
							? [path.join(workspace, "missing", "docker-language-server")]
							: [process.execPath, fakeServer],
				},
				typos: { command: [process.execPath, fakeServer] },
			},
			disabledServers: ["docker", "ast-grep", "opengrep", "zizmor"],
		}),
	);
	const file = path.join(workspace, "Dockerfile");
	fs.writeFileSync(file, "FROM alpine:3.16.1\nCMD ls\n");
	process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
	// Host-boundary stub: project command overrides need a trusted project.
	setProjectTrustState("trusted");
	const config = await import("../../clients/lsp/config.js");
	config.resetLSPConfigStateForTests();
	await config.initLSPConfig(workspace);
	const lsp = await import("../../clients/lsp/index.js");
	lsp.resetLSPService();
	service = lsp.getLSPService() as unknown as Service;
	return { file, content: fs.readFileSync(file, "utf8") };
}

/** The touch `runLspHandshake` sends, with or without auxiliaries. */
function rowTouch(auxiliaryServerIds?: string[]) {
	return {
		diagnostics: "document",
		collectDiagnostics: true,
		clientScope: auxiliaryServerIds ? "with-auxiliary" : "primary",
		...(auxiliaryServerIds ? { auxiliaryServerIds } : {}),
		maxClientWaitMs: 15_000,
		maxDiagnosticsWaitMs: 4_000,
		source: "smoke-lsp",
	};
}

afterEach(async () => {
	await service?.shutdown();
	service = undefined;
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained(PREFIX);
	resetProjectTrust();
	if (savedInstall === undefined)
		delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
	else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
});

describe("the handshake lane's reading of a touch (#4403)", () => {
	it("reads a disabled primary whose alternate is missing as no client ready", async () => {
		const row = await dockerfileRow("missing");

		const touched = await service!.touchFile(row.file, row.content, rowTouch());

		expect(touched).toMatchObject({
			inconclusiveReason: "primary-unavailable",
			disabledPrimaryServerIds: ["docker"],
		});
		expect(touchAnsweredDiagnostics(touched)).toBeUndefined();
	}, 30_000);

	it("reads the alternate's answer as an answer", async () => {
		const row = await dockerfileRow("fake");

		const touched = await service!.touchFile(row.file, row.content, rowTouch());

		expect(touchAnsweredDiagnostics(touched)).toEqual(expect.any(Array));
		expect((await service!.getWarmClientForFile(row.file))?.info.id).toBe(
			"docker-official",
		);
	}, 30_000);

	it("keeps an auxiliary row's findings when no primary answered", async () => {
		const row = await dockerfileRow("missing");

		const touched = await service!.touchFile(
			row.file,
			row.content,
			rowTouch(["typos"]),
		);

		expect(touched).toMatchObject({
			inconclusiveReason: "primary-unavailable",
		});
		expect(touchAnsweredDiagnostics(touched, { auxiliary: true })).toEqual(
			expect.any(Array),
		);
	}, 30_000);
});
