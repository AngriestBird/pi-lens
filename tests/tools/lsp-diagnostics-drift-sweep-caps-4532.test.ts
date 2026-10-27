/**
 * #4532 gap 13, round 1b: the sweep that runs before an `lsp_diagnostics`
 * answer must reach EVERY held document, not the 64 a turn-settle pass stats
 * or the 4 it re-pushes.
 *
 * Recurrence this file prevents: round 1 called the forced sweep and the first
 * call read clean only when the changed file sat in that pass's 64-document
 * window. Measured on the real service (round 1 probe): with 200 held
 * documents 2 of 4 changed files reached the server, with 500 held 1 of 4, and
 * a burst of 8 changed files pushed 4. The importer then kept the finding the
 * changed files would have cleared.
 *
 * Shape: a fresh `LSPService` per cell, `N` filler documents held first and the
 * changed modules held LAST, so a pass whose window starts at the cursor's
 * origin (a new service) cannot reach them. The importer imports the changed
 * modules; its finding clears only when the server has every one of them. The
 * server is the shared fake in its pull-mode closed-file-cache profile, so the
 * answer is exactly what the server holds when the pull arrives.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetLSPService } from "../../clients/lsp/capabilities.js";
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
const PREFIX = "pi-lens-4532-g13-caps-";
const env = setupTestEnvironment(PREFIX);
const MISSING_B = "has no exported member 'B'";

let cellCount = 0;

async function lspService() {
	const lsp = await import("../../clients/lsp/index.js");
	return lsp.getLSPService();
}

/** A project of its own with the fake server as its `.ts` custom server. */
async function openWorkspace(): Promise<string> {
	const dir = path.join(env.tmpDir, `cell-${++cellCount}`);
	fs.mkdirSync(path.join(dir, ".pi-lens"), { recursive: true });
	const shim = path.join(dir, "closed-file-server.mjs");
	fs.writeFileSync(
		shim,
		[
			'process.env.FAKE_LSP_CLOSED_FILE_CACHE = "1";',
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
	fs.writeFileSync(
		path.join(dir, ".pi-lens", "lsp.json"),
		JSON.stringify({
			servers: {
				"fake-ts": {
					name: "closed file cache server",
					extensions: [".ts"],
					command: process.execPath,
					args: [shim],
					rootMarkers: ["package.json"],
				},
			},
			disabledServers: ["typescript", "deno", "ast-grep", "typos", "opengrep"],
		}),
	);
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(dir);
	return dir;
}

async function hold(file: string): Promise<void> {
	await (
		await lspService()
	).touchFile(file, fs.readFileSync(file, "utf8"), {
		diagnostics: "none",
		clientScope: "primary",
		source: "lsp_sync",
	});
}

async function diagnose(cwd: string, file: string): Promise<string> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4532-g13-caps",
		{ path: file, serverScope: "primary", waitMs: 3000, concurrency: 1 },
		undefined,
		null,
		{ cwd },
	)) as { content: Array<{ text?: string }> };
	return String(result.content[0]?.text);
}

/**
 * `fillers` documents held first, then `changed` modules (each lacking `B`),
 * then the importer of every module. Returns what the cell rewrites.
 */
async function heldProject(fillers: number, changed: number) {
	const dir = await openWorkspace();
	for (let i = 0; i < fillers; i++) {
		const filler = path.join(dir, `filler-${i}.ts`);
		fs.writeFileSync(filler, `export const filler${i} = ${i};\n`);
		await hold(filler);
	}
	const modules = Array.from({ length: changed }, (_, i) =>
		path.join(dir, `m${i}.ts`),
	);
	for (const module of modules) {
		fs.writeFileSync(module, "export const A = 1;\n");
		await hold(module);
	}
	const importer = path.join(dir, "importer.ts");
	fs.writeFileSync(
		importer,
		modules.map((_, i) => `import { B } from "./m${i}";\n`).join(""),
	);
	return { dir, importer, modules };
}

function copyInOutsidePi(modules: readonly string[]): void {
	for (const module of modules)
		fs.writeFileSync(module, "export const A = 1;\nexport const B = 2;\n");
}

function missingCount(text: string): number {
	return text.split(MISSING_B).length - 1;
}

describe("the pre-answer sweep reaches every held document (#4532 gap 13)", () => {
	beforeAll(() => {
		// Host-boundary stub: the fixture launches a project-configured server in a
		// project pi has trusted (#4248 refuses it otherwise).
		setProjectTrustState("trusted");
	});

	afterEach(async () => {
		await (await lspService()).shutdown();
		resetLSPService();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained(PREFIX);
		resetProjectTrust();
	});

	it("clears 4 changed modules on call 1 with 200 held documents", async () => {
		const { dir, importer, modules } = await heldProject(200, 4);
		expect(missingCount(await diagnose(dir, importer))).toBe(4);

		copyInOutsidePi(modules);

		expect(missingCount(await diagnose(dir, importer))).toBe(0);
	}, 120_000);

	it("clears 4 changed modules on call 1 with 500 held documents", async () => {
		const { dir, importer, modules } = await heldProject(500, 4);
		expect(missingCount(await diagnose(dir, importer))).toBe(4);

		copyInOutsidePi(modules);

		expect(missingCount(await diagnose(dir, importer))).toBe(0);
	}, 120_000);

	it("clears a burst of 8 changed modules on call 1", async () => {
		const { dir, importer, modules } = await heldProject(0, 8);
		expect(missingCount(await diagnose(dir, importer))).toBe(8);

		copyInOutsidePi(modules);

		expect(missingCount(await diagnose(dir, importer))).toBe(0);
	}, 60_000);
});
