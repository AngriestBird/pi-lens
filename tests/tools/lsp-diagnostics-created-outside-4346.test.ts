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

/**
 * Diagnose a file no call has seen: the batch first sends any waiting Created
 * (`announceCreatedFiles` flushes the watch queue), and the touch is a round
 * trip to the server, which writes its trace line before it answers (stdio
 * keeps the order). So the trace is complete for every event sent before.
 */
let roundTrips = 0;
async function roundTrip(): Promise<void> {
	const probe = path.join(workspace, `round_trip_${roundTrips++}.ts`);
	fs.writeFileSync(probe, "export {};\n");
	await diagnose({ paths: [probe] });
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
	// Older than the client, which starts at the first diagnostics call.
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

	// Row 3b: codegen writes a gitignored module the sweep never lists, so
	// only the importer names it.
	it("clears the importer in a workspace sweep when the module is gitignored", async () => {
		fs.writeFileSync(path.join(workspace, ".gitignore"), "gen/\n");
		const importer = path.join(workspace, "swept_user.ts");
		fs.writeFileSync(importer, 'import "./gen/swept_gen";\nexport {};\n');
		const sweep = async () =>
			(
				await (
					service as unknown as {
						runWorkspaceDiagnostics: (
							cwd: string,
						) => Promise<Array<{ filePath: string; diagnostics: unknown[] }>>;
					}
				).runWorkspaceDiagnostics(workspace)
			).find((result) => result.filePath === importer)?.diagnostics.length;
		expect(await sweep()).toBe(1);
		// The importer is itself new: its first open sent Created, which drops
		// the first sweep's entry. The second records the entry under test.
		expect(await sweep()).toBe(1);

		fs.mkdirSync(path.join(workspace, "gen"));
		fs.writeFileSync(
			path.join(workspace, "gen", "swept_gen.ts"),
			"export {};\n",
		);

		expect(await sweep()).toBe(0);
	}, 60_000);

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
		await roundTrip();

		const created = path.join(workspace, "edit_created.ts");
		await applyWorkspaceEdit(
			{
				documentChanges: [{ kind: "create", uri: pathToFileURL(created).href }],
			},
			workspace,
		);
		await roundTrip();
		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 1`,
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
		await roundTrip();
		expect(watchedLines()).toContain(`watched ${pathToFileURL(moved).href} 1`);
		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 3`,
		);

		await applyWorkspaceEdit(
			{ documentChanges: [{ kind: "delete", uri: pathToFileURL(moved).href }] },
			workspace,
		);
		await roundTrip();
		expect(watchedLines()).toContain(`watched ${pathToFileURL(moved).href} 3`);
	}, 30_000);

	// Recurrence: an edit that fails mid-application has already written its
	// earlier operations ("no rollback performed"); a server must still hear
	// about the file that now exists.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"announces an applied create when a later operation fails",
		async () => {
			const { applyWorkspaceEdit } = await import("../../clients/lsp/edits.js");
			const locked = path.join(workspace, "locked");
			fs.mkdirSync(locked);
			const target = path.join(locked, "target.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			fs.chmodSync(target, 0o444);
			fs.chmodSync(locked, 0o555);
			const created = path.join(workspace, "edit_partial.ts");
			try {
				await expect(
					applyWorkspaceEdit(
						{
							documentChanges: [
								{ kind: "create", uri: pathToFileURL(created).href },
								{
									textDocument: {
										uri: pathToFileURL(target).href,
										version: null,
									},
									edits: [
										{
											range: {
												start: { line: 0, character: 13 },
												end: { line: 0, character: 14 },
											},
											newText: "b",
										},
									],
								},
							],
						},
						workspace,
					),
				).rejects.toThrow(/failed mid-application/);
			} finally {
				fs.chmodSync(locked, 0o755);
			}
			await roundTrip();
			expect(watchedLines()).toContain(
				`watched ${pathToFileURL(created).href} 1`,
			);
		},
		30_000,
	);
});

describe("the producer's cost gate (#4346)", () => {
	// Recurrence: #4344 r1, where a per-call extra pass took the cached replay
	// from 6 ms to 321 ms. A batch resolves the imports of finding-bearing
	// files only; a clean file's imports already resolved.
	it("resolves no clean file's imports in a batch", async () => {
		// Created after the client started, then imported: the server finds it
		// on its first lookup, so the importer is clean from the start.
		const module = path.join(workspace, "gate_module.ts");
		fs.writeFileSync(module, "export {};\n");
		const importer = path.join(workspace, "gate_user.ts");
		fs.writeFileSync(importer, 'import "./gate_module";\nexport {};\n');
		expect(
			(await diagnose({ paths: [importer] })).details.primaryDiagnosticsCount,
		).toBe(0);
		await diagnose({ paths: [importer] });

		await roundTrip();
		expect(watchedLines()).not.toContain(
			`watched ${pathToFileURL(module).href} 1`,
		);
	}, 30_000);
});
