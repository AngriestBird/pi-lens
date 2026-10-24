// flake-shape: in-process-mock — the LSP client is a spawned language-server process (JSON-RPC over stdio), and this file's subject is the registry's spawn policy and bookkeeping, not the process
/**
 * #4806 — csharp-ls aborts the whole process (SIGABRT, one core dump per
 * attempt) when its cwd has no `.sln`/`.slnx`/`.csproj` anywhere below it. The
 * root fallback hands it the file's own directory (a Unity `Assets/**` tree has
 * no solution), so the registry declines the spawn BEFORE any process starts.
 *
 * The decline sits on the policy path beside `declinesLooseFileRoot` (#4760):
 * no `spawn_failed`, no failure ladder, no breaker, one bounded record per
 * (server, root). The root functions and the registry are production; the
 * spawn (the launched binary) is the only double, as in the #4760 file.
 *
 * Recurrences guarded: the contributor's first shape declined inside
 * `CSharpServer.spawn` (returning `undefined`), which the registry books as
 * tool unavailability and climbs toward `permanentlyBroken` after five
 * attempts (F5); its top-level-only `readdir` regex declined a root whose
 * project sits in a subdirectory, which csharp-ls loads (F4), and admitted a
 * directory named `App.csproj` and an upper-case extension on Linux, which the
 * module's own marker rule refuses (F3).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	CSharpServer,
	FSharpServer,
	OmniSharpServer,
	PROJECT_FILE_SEARCH_MAX_DIRS,
	declinesProjectlessRoot,
	type LSPServerInfo,
} from "../../../clients/lsp/server.js";
import {
	ClientRegistry,
	type ClientGenerationHooks,
	type LSPClientAcquisitionOutcome,
} from "../../../clients/lsp/client-registry.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { removeTempDirSync } from "../test-utils.js";

const createLSPClient = vi.hoisted(() => vi.fn());

vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

function makeFakeProcess() {
	return {
		process: {
			killed: false,
			kill: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		},
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
		stderr: { on: vi.fn(), off: vi.fn() },
		pid: 4242,
	};
}

function makeHooks(): ClientGenerationHooks {
	return {
		releaseNotifyWrite: () => undefined,
		forgetReadiness: () => undefined,
		forgetNotifyBacklog: () => undefined,
		clearStallDemotion: () => undefined,
		rearmFirstContact: () => undefined,
		noteDiagnosticsPublished: () => undefined,
	};
}

/** The production csharp row with only the launched binary stubbed. */
function csharpWithStubSpawn(): LSPServerInfo & {
	spawn: ReturnType<typeof vi.fn>;
} {
	return {
		...CSharpServer,
		spawn: vi.fn(async () => ({
			process: makeFakeProcess() as never,
			source: "direct" as const,
		})),
	} as LSPServerInfo & { spawn: ReturnType<typeof vi.fn> };
}

const tempDirs: string[] = [];

beforeEach(() => {
	// csharp-ls executes project code, so the registry's trust backstop admits
	// it only for a trusted project (the host boundary; the trust seam itself
	// is covered by lsp-registry-trust).
	setProjectTrustState("trusted");
	resetDegradationLedger();
	createLSPClient.mockReset();
	createLSPClient.mockRejectedValue(new Error("stubbed initialize"));
});

afterEach(() => {
	resetProjectTrust();
	for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
	resetDegradationLedger();
});

/**
 * A marker-less tree outside the checkout: a tree inside it has this
 * repository's `.git` as an ancestor, which would not matter for the .NET
 * markers but keeps the fixture shape of the sibling #4760 file.
 */
function tree(slug: string): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-4806-${slug}-`)),
	);
	tempDirs.push(root);
	return root;
}

function csFile(dir: string): string {
	const file = path.join(dir, "Script.cs");
	fs.writeFileSync(file, "class Script {}\n");
	return file;
}

function plant(dir: string, ...segments: string[]): void {
	const file = path.join(dir, ...segments);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "<Project />\n");
}

/** One acquisition of the C# client for `file` in a fresh registry. */
async function acquire(
	dir: string,
	file: string,
	server = csharpWithStubSpawn(),
): Promise<{
	server: typeof server;
	registry: ClientRegistry;
	outcome: LSPClientAcquisitionOutcome | undefined;
}> {
	const registry = new ClientRegistry(makeHooks(), undefined, dir);
	let outcome: LSPClientAcquisitionOutcome | undefined;
	await registry.ensureClientForServer(
		file,
		server,
		undefined,
		undefined,
		(value) => {
			outcome = value;
		},
	);
	return { server, registry, outcome };
}

describe("csharp-ls spawn needs a project file below its root (#4806)", () => {
	it("declines a project-less root as a policy decline: no spawn, no breaker, one record", async () => {
		const dir = tree("declined");
		const file = csFile(dir);
		const server = csharpWithStubSpawn();
		const registry = new ClientRegistry(makeHooks(), undefined, dir);
		const outcomes: Array<LSPClientAcquisitionOutcome | undefined> = [];

		// Six attempts: one more than BROKEN_PERMANENT_AFTER, so the ladder the
		// contributor's `return undefined` climbed would have latched by now.
		for (let attempt = 0; attempt < 6; attempt += 1) {
			await registry.ensureClientForServer(
				file,
				server,
				undefined,
				undefined,
				(value) => outcomes.push(value),
			);
		}

		expect(server.spawn).not.toHaveBeenCalled();
		expect(outcomes).toEqual(Array(6).fill("declined"));
		expect(registry.permanentlyBroken.size).toBe(0);
		expect(registry.broken.size).toBe(0);
		const declined = getDegradationSummary().find(
			(group) => group.kind === "lsp-root-declined",
		);
		expect(declined?.count).toBe(1);
		expect(declined?.latestReasons[0]?.subject).toBe(
			`csharp:${normalizeMapKey(dir)}`,
		);
	});

	it("spawns where the root itself holds a solution or project file", async () => {
		const dir = tree("top-level");
		plant(dir, "App.csproj");
		const { server, outcome } = await acquire(dir, csFile(dir));

		expect(server.spawn).toHaveBeenCalledTimes(1);
		expect(outcome).not.toBe("declined");
	});

	// F4: the fallback root is the file's own directory, and csharp-ls loads a
	// project anywhere below its cwd (`SearchOption.AllDirectories`).
	it("spawns where a project sits in a subdirectory of the root", async () => {
		const dir = tree("nested");
		plant(dir, "src", "App", "App.csproj");
		const { server } = await acquire(dir, csFile(dir));

		expect(server.spawn).toHaveBeenCalledTimes(1);
	});

	// F3: the module's own marker rule (`markerExists` over the shared .NET
	// markers) is files-only, and case-folded on win32 alone.
	it("declines a directory named like a project file", async () => {
		const dir = tree("dir-named");
		fs.mkdirSync(path.join(dir, "App.csproj"));
		const { server, outcome } = await acquire(dir, csFile(dir));

		expect(server.spawn).not.toHaveBeenCalled();
		expect(outcome).toBe("declined");
	});

	it.skipIf(process.platform === "win32")(
		"declines an upper-case project extension off Windows",
		async () => {
			const dir = tree("upper-ext");
			plant(dir, "App.CSPROJ");
			const { server } = await acquire(dir, csFile(dir));

			expect(server.spawn).not.toHaveBeenCalled();
		},
	);

	it("does not look under directories the walkers exclude", async () => {
		const dir = tree("excluded");
		plant(dir, "node_modules", "pkg", "App.csproj");
		const { server } = await acquire(dir, csFile(dir));

		expect(server.spawn).not.toHaveBeenCalled();
	});

	// The bound: breadth-first, at most PROJECT_FILE_SEARCH_MAX_DIRS directories
	// read, root included. A tree wider than the bound reads as project-less
	// (decline) rather than being walked without limit.
	it("reads at most the bounded number of directories", async () => {
		const wide = tree("bound-wide");
		const narrow = tree("bound-narrow");
		for (let index = 0; index < PROJECT_FILE_SEARCH_MAX_DIRS + 2; index += 1) {
			plant(wide, `d${index}`, "x", "App.csproj");
		}
		for (let index = 0; index < PROJECT_FILE_SEARCH_MAX_DIRS / 2; index += 1) {
			plant(narrow, `d${index}`, "x", "App.csproj");
		}

		// Every child of `wide` is a candidate, but the budget is spent on the
		// root and its children before any grandchild is read.
		expect(await declinesProjectlessRoot(CSharpServer, wide)).toBe(true);
		// Half as many children leave budget for their grandchildren.
		expect(await declinesProjectlessRoot(CSharpServer, narrow)).toBe(false);
	});

	// F8: only the server whose abort is reproduced declares the trait.
	it("is declared by csharp-ls alone among the .NET rows", () => {
		expect(CSharpServer.spawnNeedsProjectFile).toBe(true);
		expect(OmniSharpServer.spawnNeedsProjectFile).toBeUndefined();
		expect(FSharpServer.spawnNeedsProjectFile).toBeUndefined();
	});

	it("never declines a server that does not declare the trait", async () => {
		const dir = tree("undeclared");
		expect(await declinesProjectlessRoot(OmniSharpServer, dir)).toBe(false);
	});
});
