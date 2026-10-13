/**
 * #4346: a module created outside pi-lens (a shell, `cp`, codegen) reached no
 * language server, because no tool result names it. A server that caches a
 * failed lookup (Pyrefly and pyright, measured) kept the importer's missing
 * import for its whole life when only the importer was diagnosed. A workspace
 * edit's resource operations (create, rename, delete) sent no watched-files
 * event either.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, LSPService, client and
 * workspace edit applier over a stdio JSON-RPC wire. The server is the shared
 * fake in its stale-lookup profile, configured as the project's server for
 * `.ts` files (the built-in one disabled), for `import "./name"` lines that
 * resolve to `name.ts`, which the review graph's extraction also reads.
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
const env = setupTestEnvironment("pi-lens-4346-outside-");
const workspace = env.tmpDir;
const trace = path.join(workspace, "server.trace");

async function diagnose(
	args: { paths: string[] } | { path: string },
): Promise<{ text: string; details: Record<string, unknown> }> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4346",
		{ ...args, serverScope: "primary", waitMs: 3000, concurrency: 1 },
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

function watchedLines(): string[] {
	if (!fs.existsSync(trace)) return [];
	return fs
		.readFileSync(trace, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("watched "));
}

/** The watch queue flushes after its 100 ms window; wait past it. */
async function untilWatched(line: string): Promise<boolean> {
	for (let attempt = 0; attempt < 40; attempt++) {
		if (watchedLines().includes(line)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

let service: { shutdown: () => Promise<void> } | undefined;

beforeAll(async () => {
	// Host-boundary stub: a project-configured server needs pi's trust (#4248).
	setProjectTrustState("trusted");
	const shim = path.join(workspace, "stale-lookup-server.mjs");
	fs.writeFileSync(
		shim,
		[
			'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
			'process.env.FAKE_LSP_STALE_MODULE_LOOKUP = "1";',
			'process.env.FAKE_LSP_STALE_MODULE_EXT = ".ts";',
			`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"outside","version":"0.0.0"}\n',
	);
	// Born before any server starts: an existing module, never Created.
	fs.writeFileSync(path.join(workspace, "old_module.ts"), "export {};\n");
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			servers: {
				"stale-ts": {
					name: "stale lookup server",
					extensions: [".ts"],
					command: process.execPath,
					args: [shim],
					rootMarkers: ["package.json"],
				},
			},
			disabledServers: ["typescript", "deno", "opengrep", "ast-grep", "typos"],
		}),
	);
	// Older than the client: the server's start is the birth gate.
	await new Promise((resolve) => setTimeout(resolve, 150));
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(workspace);
	const lsp = await import("../../clients/lsp/index.js");
	service = lsp.getLSPService();
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained("pi-lens-4346-outside-", {
		beforeDrain: async () => {
			await service?.shutdown();
		},
	});
	resetProjectTrust();
});

describe("a module created outside pi-lens (#4346)", () => {
	it("clears the importer when only the importer is diagnosed after the module appears", async () => {
		const importer = path.join(workspace, "batch_user.ts");
		fs.writeFileSync(importer, 'import "./batch_module";\nexport {};\n');
		expect(
			(await diagnose({ paths: [importer] })).details.primaryDiagnosticsCount,
		).toBe(1);

		// Outside pi-lens: no tool result, no pi write, no open of the module.
		const created = path.join(workspace, "batch_module.ts");
		fs.writeFileSync(created, "export {};\n");
		const after = await diagnose({ paths: [importer] });

		expect(after.text).not.toContain("Cannot find module batch_module");
		expect(after.details.primaryDiagnosticsCount).toBe(0);
		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 1`,
		);
	}, 30_000);

	it("clears the importer on the single-file route too", async () => {
		const importer = path.join(workspace, "scalar_user.ts");
		fs.writeFileSync(importer, 'import "./scalar_module";\nexport {};\n');
		expect((await diagnose({ path: importer })).text).toContain(
			"Cannot find module scalar_module",
		);

		fs.writeFileSync(path.join(workspace, "scalar_module.ts"), "export {};\n");
		const after = await diagnose({ path: importer });

		expect(after.text).not.toContain("Cannot find module scalar_module");
	}, 30_000);

	it("announces no module born before the server started", async () => {
		const importer = path.join(workspace, "old_user.ts");
		fs.writeFileSync(
			importer,
			'import "./old_module";\nimport "./never_module";\nexport {};\n',
		);
		const first = await diagnose({ paths: [importer] });
		// The import that never resolves keeps reporting.
		expect(first.text).toContain("Cannot find module never_module");
		await diagnose({ paths: [importer] });

		const oldUri = pathToFileURL(path.join(workspace, "old_module.ts")).href;
		expect(watchedLines()).not.toContain(`watched ${oldUri} 1`);
	}, 30_000);
});

describe("a workspace edit's resource operations (#4346)", () => {
	it("sends Created, Deleted, and the rename pair the moment they reach disk", async () => {
		const { applyWorkspaceEdit } = await import("../../clients/lsp/edits.js");
		// A live client must exist for the events to reach a server.
		const seed = path.join(workspace, "edit_seed.ts");
		fs.writeFileSync(seed, "export {};\n");
		await diagnose({ paths: [seed] });

		const created = path.join(workspace, "edit_created.ts");
		await applyWorkspaceEdit(
			{
				documentChanges: [{ kind: "create", uri: pathToFileURL(created).href }],
			},
			workspace,
		);
		expect(await untilWatched(`watched ${pathToFileURL(created).href} 1`)).toBe(
			true,
		);

		const moved = path.join(workspace, "edit_moved.ts");
		await applyWorkspaceEdit(
			{
				documentChanges: [
					{
						kind: "rename",
						oldUri: pathToFileURL(created).href,
						newUri: pathToFileURL(moved).href,
					},
				],
			},
			workspace,
		);
		expect(await untilWatched(`watched ${pathToFileURL(moved).href} 1`)).toBe(
			true,
		);
		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 3`,
		);

		await applyWorkspaceEdit(
			{ documentChanges: [{ kind: "delete", uri: pathToFileURL(moved).href }] },
			workspace,
		);
		expect(await untilWatched(`watched ${pathToFileURL(moved).href} 3`)).toBe(
			true,
		);
	}, 30_000);
});
