/**
 * #4403: every diagnostics entry route, under every switch that selects
 * servers, starts the same servers and gives the same confirmation verdict.
 *
 * Recurrence: #4322 (a missing primary reported clean from an auxiliary alone)
 * and #4323 (explicit checks started a switched-off Opengrep). Both were fixed
 * route by route (#4390, #4391), and #4391's review found a seventh route still
 * drifting. Nothing stopped the next route from drifting the same way.
 *
 * Two halves:
 *
 * Each cell also reads the reason a route gives when no primary answered: a
 * disabled primary and a missing one are both unconfirmed, and every route
 * that renders a reason names the primary and says which (#4403's decision,
 * the #4322 rule extended to `lsp.disabledServers`).
 *
 * 1. The route list is derived from code. Every production read of an
 *    `LSPService` member that starts a server or returns diagnostics
 *    (`DIAGNOSTICS_ENTRY_MEMBERS`) is a site. The AST scan never sees a
 *    comment or a string, so prose cannot add or satisfy a site. Each site maps
 *    to a matrix route or carries an exemption whose key holds the site's
 *    `clientScope` and `diagnostics` options, so a site that widens its scope
 *    gets a new key and has to be placed again. A new site reds; so does a
 *    registry entry whose site is gone, and a route the registry names that the
 *    matrix does not drive.
 *
 * 2. The matrix drives each route through its real entry: pi's `tool_result`
 *    and `turn_end` hooks and the `lens_diagnostics` and `lsp_navigation`
 *    tools that the real extension activation registers, and the real MCP
 *    server over stdio. Language servers are the host boundary: each one's
 *    command is a project override pointing at a shim that appends the server
 *    id to a marker file and then runs the shared fake server, which answers
 *    every pull with no findings. A missing primary's command points at a path
 *    that does not exist. Each cell gets a fresh LSP service, so the marker
 *    lines a cell adds are the servers that route started.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { afterAll, describe, expect, it } from "vitest";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { getLensFlagSpec } from "../../clients/lens-flag-registry.js";
import { getLSPService, resetLSPService } from "../../clients/lsp/index.js";
import { clearWorkspaceDiagnosticsCache } from "../../clients/lsp/workspace-diagnostics-cache.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { McpHarness, testTimeoutScale } from "../mcp/harness.js";
import { makeSessionStartEvent } from "../support/host-event-factory.js";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import {
	auditRegistry,
	findEnclosingSymbol,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const fakeServer = path.join(
	repoRoot,
	"tests",
	"fixtures",
	"fake-lsp-server.mjs",
);
const PREFIX = "pi-lens-4403-matrix-";

// ── The routes and switches ─────────────────────────────────────────────────

const ROUTES = [
	"write-time dispatch",
	"lsp_diagnostics file",
	"lsp_diagnostics batch",
	"lsp_diagnostics directory",
	"lsp_diagnostics primary-only",
	"MCP pilens_diagnostics",
	"lsp_navigation workspaceDiagnostics",
	"turn-end actionable warnings",
	"lens_diagnostics mode=full",
] as const;
type RouteId = (typeof ROUTES)[number];

/**
 * Which servers a route asks for, given the servers the configuration selects:
 * `all` asks every selected server; `primary` asks the language server, and
 * when none answers its clientless fallback asks every selected server (#4322);
 * `sweep` is the `mode=full` engine, which leaves Opengrep to its CLI extractor
 * (`WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS`, #584) and starts nothing for a file
 * whose language server cannot start.
 */
type RouteScope = "all" | "primary" | "sweep";
const ROUTE_SCOPE: Record<RouteId, RouteScope> = {
	"write-time dispatch": "all",
	"lsp_diagnostics file": "all",
	"lsp_diagnostics batch": "all",
	"lsp_diagnostics directory": "all",
	"lsp_diagnostics primary-only": "primary",
	"MCP pilens_diagnostics": "all",
	"lsp_navigation workspaceDiagnostics": "all",
	"turn-end actionable warnings": "all",
	"lens_diagnostics mode=full": "sweep",
};

/**
 * A route that renders no confirmation verdict, with the reason. Every other
 * route's verdict is read from what it shows the agent.
 */
const NO_VERDICT_SURFACE: Partial<Record<RouteId, string>> = {
	"turn-end actionable warnings":
		"it reports only warnings that carry a code action; a file with none adds nothing, clean or not",
};

type ColumnId =
	| "control"
	| "--no-opengrep"
	| "opengrep.enabled=false"
	| "primary disabled"
	| "primary missing";

interface Column {
	id: ColumnId;
	/** pi CLI flags. */
	piFlags: Record<string, boolean>;
	/** `~/.pi-lens/config.json`, through PI_LENS_CONFIG_PATH. */
	globalConfig: Record<string, unknown>;
	/** The JSON language server: a working fake, off in lsp.json, or a missing binary. */
	primary: "fake" | "disabled" | "missing";
	opengrepOff: boolean;
}

const COLUMNS: readonly Column[] = [
	{
		id: "control",
		piFlags: {},
		globalConfig: {},
		primary: "fake",
		opengrepOff: false,
	},
	{
		id: "--no-opengrep",
		piFlags: { "no-opengrep": true },
		globalConfig: {},
		primary: "fake",
		opengrepOff: true,
	},
	{
		id: "opengrep.enabled=false",
		piFlags: {},
		globalConfig: { opengrep: { enabled: false } },
		primary: "fake",
		opengrepOff: true,
	},
	{
		id: "primary disabled",
		piFlags: {},
		globalConfig: {},
		primary: "disabled",
		opengrepOff: false,
	},
	{
		id: "primary missing",
		piFlags: {},
		globalConfig: {},
		primary: "missing",
		opengrepOff: false,
	},
];

/**
 * A cell that cannot exist, with the reason. The MCP server has no CLI flags:
 * it resolves `no-opengrep` from config only (`createMcpHost`), so its switch
 * is the `opengrep.enabled=false` column. A case below reds if the flag ever
 * gains an environment spelling the MCP host could read.
 */
const NOT_APPLICABLE: ReadonlyArray<{
	route: RouteId;
	column: ColumnId;
	why: string;
}> = [
	{
		route: "MCP pilens_diagnostics",
		column: "--no-opengrep",
		why: "the MCP host has no CLI flags; it reads no-opengrep from config only",
	},
];

type Verdict = "clean" | "unconfirmed" | "findings" | "unsupported";

/**
 * Verdicts that differ from their column's, kept visible until a decision
 * lands. Shrink-only: a row whose route stops diverging reds as a mismatch, and
 * so does a new divergence. Empty since the disabled-primary decision (#4403):
 * batch and directory used to read a file with its primary off in `lsp.json`
 * as `unsupported` while the other routes called it clean.
 */
const KNOWN_VERDICT_DIVERGENCES: ReadonlyArray<{
	route: RouteId;
	column: ColumnId;
	verdict: Verdict;
}> = [];

/**
 * A route that renders no reason text the matrix reads, with why. Every other
 * route's note is read from what it shows the agent.
 */
const NO_NOTE_SURFACE: Partial<Record<RouteId, string>> = {
	"write-time dispatch":
		"the matrix reads the dispatch report's runner status row, which carries no reason text",
	"turn-end actionable warnings":
		"it reports only warnings that carry a code action; a file with none adds nothing",
};

/** The servers a column's configuration selects for a JSON file. */
function selectedServers(column: Column): string[] {
	return [
		...(column.primary === "fake" ? ["json"] : []),
		...(column.opengrepOff ? [] : ["opengrep"]),
		"typos",
	].sort();
}

function expectedStarted(route: RouteId, column: Column): string[] {
	const selected = selectedServers(column);
	switch (ROUTE_SCOPE[route]) {
		case "all":
			return selected;
		case "primary":
			return column.primary === "fake" ? ["json"] : selected;
		case "sweep":
			return column.primary === "missing"
				? []
				: selected.filter((id) => id !== "opengrep");
	}
}

/**
 * The column's verdict, from the rules alone: a working language server that
 * answers clean confirms the file, switches that drop only Opengrep change
 * nothing about that, and auxiliaries never confirm a file whose primary did
 * not answer, whether it could not start (#4322) or is off in config (#4403).
 */
function expectedVerdict(column: Column): Verdict {
	return column.primary === "fake" ? "clean" : "unconfirmed";
}

/**
 * The reason a route gives when no primary answered: the primary it names and
 * why. The sweep's note counts files instead of naming servers, so it gives
 * both causes at once.
 */
function expectedNote(route: RouteId, column: Column): string {
	if (NO_NOTE_SURFACE[route] !== undefined) return "n/a";
	if (column.primary === "fake") return "none";
	if (ROUTE_SCOPE[route] === "sweep") return "either";
	return column.primary === "disabled"
		? "json: disabled in config"
		: "json: not started";
}

type Cell = { started: string[] | "n/a"; verdict: string; note: string };

function expectedRow(column: Column): Record<RouteId, Cell> {
	const row = {} as Record<RouteId, Cell>;
	for (const route of ROUTES) {
		if (
			NOT_APPLICABLE.some((na) => na.route === route && na.column === column.id)
		) {
			row[route] = { started: "n/a", verdict: "n/a", note: "n/a" };
			continue;
		}
		const divergence = KNOWN_VERDICT_DIVERGENCES.find(
			(known) => known.route === route && known.column === column.id,
		);
		row[route] = {
			started: expectedStarted(route, column),
			verdict:
				NO_VERDICT_SURFACE[route] !== undefined
					? "none"
					: (divergence?.verdict ?? expectedVerdict(column)),
			note: expectedNote(route, column),
		};
	}
	return row;
}

// ── Verdict readers: what each route shows the agent ───────────────────────

/** The single-file renderer's verdict line, shared by pi and MCP. */
function fileModeVerdict(text: string): string {
	const line = text.split("\n")[0] ?? "";
	if (/^Primary LSP[^:]*: confirmed clean\./.test(line)) return "clean";
	if (/^Primary LSP[^:]*: (not available|unconfirmed|timed out)/.test(line))
		return "unconfirmed";
	return `unread: ${line}`;
}

/**
 * The primary a route names as not answering, and the cause it gives:
 * `<ids>: disabled in config`, `<ids>: not started`, a bare cause when the
 * text names no server (`either` when it gives both), or `none`.
 */
function primaryNote(text: string): string {
	const disabled = text.includes("disabled in config");
	const unstarted = text.includes("could not be started");
	const cause =
		disabled && unstarted
			? "either"
			: disabled
				? "disabled in config"
				: unstarted
					? "not started"
					: "none";
	const named = /Primary LSP \(([^)]*)\): not available/.exec(text);
	return named && cause !== "none" ? `${named[1]}: ${cause}` : cause;
}

/** The per-file reasons a batch or directory gives in its outcomes. */
function batchNote(details: Record<string, unknown> | undefined): string {
	const outcomes = (details?.outcomes ?? []) as Array<{ reason?: string }>;
	const notes = [
		...new Set(outcomes.map((entry) => primaryNote(entry.reason ?? ""))),
	];
	return notes.length === 1
		? (notes[0] as string)
		: `mixed: ${notes.join(",")}`;
}

const BATCH_OUTCOME_VERDICT: Record<string, Verdict> = {
	clean: "clean",
	findings: "findings",
	inconclusive: "unconfirmed",
	unavailable: "unconfirmed",
	unsupported: "unsupported",
};

function batchVerdict(details: Record<string, unknown> | undefined): string {
	const outcomes = (details?.outcomes ?? []) as Array<{ outcome?: string }>;
	const verdicts = [
		...new Set(
			outcomes.map(
				(entry) =>
					BATCH_OUTCOME_VERDICT[entry.outcome ?? ""] ??
					`unread: ${entry.outcome}`,
			),
		),
	];
	return verdicts.length === 1
		? (verdicts[0] as string)
		: `mixed: ${verdicts.join(",")}`;
}

/** The dispatch report's LSP runner row for the written file. */
function writeTimeVerdict(
	runner: { status: string; diagnosticCount: number } | undefined,
): string {
	if (!runner) return "unread: no lsp runner row";
	if (runner.status === "succeeded")
		return runner.diagnosticCount > 0 ? "findings" : "clean";
	if (runner.status === "skipped" || runner.status === "deferred")
		return "unconfirmed";
	return `unread: ${runner.status}`;
}

/** The navigation envelope pi delivers (before the delivery footer). */
function navigationVerdict(text: string): string {
	const envelope = JSON.parse(text.split("\n\nresult ")[0] ?? "") as {
		resultCount?: number;
		metadata?: { unconfirmed?: boolean };
	};
	if (envelope.metadata?.unconfirmed === true) return "unconfirmed";
	return (envelope.resultCount ?? 0) > 0 ? "findings" : "clean";
}

function sweepVerdict(details: Record<string, unknown> | undefined): string {
	const confirmed = Number(details?.lspFilesConfirmed ?? 0);
	const unconfirmed = Number(details?.lspFilesUnconfirmed ?? 0);
	if (unconfirmed > 0) return "unconfirmed";
	if (confirmed > 0) return "clean";
	return "unread: no LSP file counted";
}

// ── Fixture ─────────────────────────────────────────────────────────────────

interface Fixture {
	workspace: string;
	marker: string;
	configPath: string;
	file: (relative: string) => string;
}

function makeFixture(column: Column): Fixture {
	const env = setupTestEnvironment(PREFIX);
	// The real path: on macOS the tmpdir is a `/var` -> `/private/var` alias.
	const workspace = fs.realpathSync(env.tmpDir);
	const marker = path.join(workspace, "server-starts.txt");
	const shim = (serverId: string): string[] => {
		const file = path.join(workspace, `${serverId}-server.mjs`);
		fs.writeFileSync(
			file,
			[
				'import { appendFileSync } from "node:fs";',
				`appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${serverId}\n`)});`,
				'process.env.FAKE_LSP_RESPOND_PULL_WITH = "empty";',
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		return [process.execPath, file];
	};
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"synthetic-4403-fixture","private":true}\n',
	);
	// typos and Opengrep root at the nearest `.git` (clients/lsp/server.ts).
	fs.mkdirSync(path.join(workspace, ".git"));
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				json: {
					command:
						column.primary === "missing"
							? [
									path.join(workspace, "missing", "json-language-server"),
									"--stdio",
								]
							: shim("json"),
				},
				typos: { command: shim("typos") },
				opengrep: { command: shim("opengrep") },
			},
			// `rust` is a disabled primary for another language: no JSON file's
			// note may name it, in any column.
			disabledServers: [
				"ast-grep",
				"zizmor",
				"rust",
				...(column.primary === "disabled" ? ["json"] : []),
			],
			// A configured warm file that does not exist: session_start's
			// dominant-language warm-up would otherwise start the JSON server in
			// the background, inside whichever cell runs next.
			warmFiles: ["no-such-warm-file.json"],
		}),
	);
	// Outside `.pi-lens`, so it is a global config file only.
	const configPath = path.join(workspace, "global-config.json");
	fs.writeFileSync(configPath, `${JSON.stringify(column.globalConfig)}\n`);
	return {
		workspace,
		marker,
		configPath,
		file: (relative) => {
			const target = path.join(workspace, relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, `{"${path.basename(relative, ".json")}": 1}\n`);
			return target;
		},
	};
}

function markerLines(marker: string): string[] {
	if (!fs.existsSync(marker)) return [];
	return fs.readFileSync(marker, "utf8").split("\n").filter(Boolean);
}

type ToolLike = {
	execute: (...args: unknown[]) => Promise<{
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	}>;
};

/** Runs every in-process route of one column through pi, then the MCP route. */
async function runColumn(column: Column): Promise<Record<RouteId, Cell>> {
	const fx = makeFixture(column);
	const observed = {} as Record<RouteId, Cell>;
	const savedConfigPath = process.env.PI_LENS_CONFIG_PATH;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;
	// The harness points PI_LENS_CONFIG_PATH at a missing file
	// (tests/support/vitest-setup.ts); this column's global config replaces it.
	process.env.PI_LENS_CONFIG_PATH = fx.configPath;
	// Never fetch a real vscode-json-language-server for the missing primary.
	process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
	try {
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(fx.workspace);
		const { default: extension } = await import("../../index.js");
		const { getLatencyReports, clearLatencyReports } =
			await import("../../clients/dispatch/dispatcher.js");
		const { _awaitDeferredLspPullForTest } =
			await import("../../clients/actionable-warnings.js");
		const pi = createPiMock({
			...column.piFlags,
			"lens-actionable-warnings": true,
			"lens-actionable-warning-actions": true,
		});
		extension(pi.asExtensionAPI());
		// The host's own trust decision, which session_start latches: the
		// command overrides are project config (#4248).
		const ctx = makeCtx({
			cwd: fx.workspace,
			sessionId: `matrix-4403-${column.id}`,
			isProjectTrusted: true,
		});
		await pi.emit("session_start", makeSessionStartEvent(), ctx);
		await pi.emit("turn_start", {}, ctx);

		/** A fresh service, so the marker lines `work` adds are its starts. */
		const cell = async (
			route: RouteId,
			work: () => Promise<{ verdict: string; note: string }>,
		): Promise<void> => {
			resetLSPService();
			getLSPService();
			clearWorkspaceDiagnosticsCache(fx.workspace);
			const from = markerLines(fx.marker).length;
			const { verdict, note } = await work();
			observed[route] = {
				started: [...new Set(markerLines(fx.marker).slice(from))].sort(),
				verdict,
				note,
			};
		};
		const lens = pi.tools.get("lens_diagnostics") as ToolLike;
		const nav = pi.tools.get("lsp_navigation") as ToolLike;
		const lspCheck = (params: Record<string, unknown>) =>
			lens.execute(
				"matrix-4403",
				{ source: "lsp", waitMs: 3000, ...params },
				undefined,
				null,
				{ cwd: fx.workspace },
			);

		await cell("write-time dispatch", async () => {
			clearLatencyReports();
			const written = fx.file("write.json");
			await pi.emit(
				"tool_result",
				{
					toolName: "write",
					input: { path: written, content: fs.readFileSync(written, "utf8") },
					content: [{ type: "text", text: "wrote" }],
				},
				ctx,
			);
			const report = getLatencyReports().find(
				(entry) => path.resolve(entry.filePath) === written,
			);
			return {
				verdict: writeTimeVerdict(
					report?.runners.find((runner) => runner.runnerId === "lsp"),
				),
				note: "n/a",
			};
		});
		await cell("lsp_diagnostics file", async () => {
			const result = await lspCheck({ path: fx.file("file.json") });
			const text = String(result.content[0]?.text);
			return { verdict: fileModeVerdict(text), note: primaryNote(text) };
		});
		await cell("lsp_diagnostics batch", async () => {
			const result = await lspCheck({
				paths: [fx.file("batch-a.json"), fx.file("batch-b.json")],
			});
			return {
				verdict: batchVerdict(result.details),
				note: batchNote(result.details),
			};
		});
		await cell("lsp_diagnostics directory", async () => {
			fx.file("dir/inner.json");
			const result = await lspCheck({ path: path.join(fx.workspace, "dir") });
			return {
				verdict: batchVerdict(result.details),
				note: batchNote(result.details),
			};
		});
		await cell("lsp_diagnostics primary-only", async () => {
			const result = await lspCheck({
				path: fx.file("primary.json"),
				serverScope: "primary",
			});
			const text = String(result.content[0]?.text);
			return { verdict: fileModeVerdict(text), note: primaryNote(text) };
		});
		await cell("lsp_navigation workspaceDiagnostics", async () => {
			const result = await nav.execute(
				"matrix-4403-nav",
				{ operation: "workspaceDiagnostics", path: fx.file("nav.json") },
				new AbortController().signal,
				null,
				ctx,
			);
			const text = String(result.content[0]?.text);
			return { verdict: navigationVerdict(text), note: primaryNote(text) };
		});
		await cell("lens_diagnostics mode=full", async () => {
			const result = await lens.execute(
				"matrix-4403-full",
				{ mode: "full", paths: [fx.file("sweep.json")] },
				undefined,
				null,
				{ cwd: fx.workspace },
			);
			return {
				verdict: sweepVerdict(result.details),
				note: primaryNote(String(result.content[0]?.text)),
			};
		});
		// The turn's edit runs its own dispatch first; the cell starts after it,
		// with a fresh service, so turn_end's cold read is the only reader left.
		const edited = fx.file("turn.json");
		await pi.emit(
			"tool_result",
			{
				toolName: "edit",
				input: { path: edited },
				details: { diff: "+  1 changed();" },
				content: [{ type: "text", text: "changed" }],
			},
			ctx,
		);
		await cell("turn-end actionable warnings", async () => {
			await pi.emit("turn_end", {}, ctx);
			await _awaitDeferredLspPullForTest();
			return { verdict: "none", note: "n/a" };
		});
		await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		await getLSPService().shutdown();
		resetLSPService();

		observed["MCP pilens_diagnostics"] = NOT_APPLICABLE.some(
			(na) => na.route === "MCP pilens_diagnostics" && na.column === column.id,
		)
			? { started: "n/a", verdict: "n/a", note: "n/a" }
			: await runMcpCell(fx);
	} finally {
		if (savedConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
		else process.env.PI_LENS_CONFIG_PATH = savedConfigPath;
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	}
	return observed;
}

/** `pilens_diagnostics source=lsp` through the real MCP server process. */
async function runMcpCell(fx: Fixture): Promise<Cell> {
	const from = markerLines(fx.marker).length;
	const probe = fx.file("mcp.json");
	const harness = new McpHarness({
		cwd: fx.workspace,
		env: {
			PI_LENS_CONFIG_PATH: fx.configPath,
			PI_LENS_DISABLE_LSP_INSTALL: "1",
			PI_LENS_DISABLE_TOOL_INSTALL: "1",
		},
	});
	try {
		await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "matrix-4403", version: "0" },
		});
		harness.notify("notifications/initialized");
		const response = await harness.request(
			2,
			"tools/call",
			{
				name: "pilens_diagnostics",
				arguments: {
					source: "lsp",
					path: probe,
					serverScope: "all",
					waitMs: 3000,
				},
			},
			60_000 * testTimeoutScale,
		);
		const result = response.result as { content: Array<{ text: string }> };
		const text = result.content[0]?.text ?? "";
		return {
			started: [...new Set(markerLines(fx.marker).slice(from))].sort(),
			verdict: fileModeVerdict(text),
			note: primaryNote(text),
		};
	} finally {
		harness.dispose();
	}
}

// ── Route derivation ────────────────────────────────────────────────────────

/**
 * The `LSPService` members a route enters the diagnostics pipeline through:
 * each one starts a server or returns diagnostics rows. A case below checks
 * every name is still a method of the service, so a rename cannot leave the
 * scan looking for a name nothing calls.
 */
const DIAGNOSTICS_ENTRY_MEMBERS = [
	"getAllDiagnostics",
	"getAuxiliaryClientsForFile",
	"getClientsForFile",
	"getDiagnostics",
	"getLastKnownDiagnostics",
	"readCachedDiagnosticsForServers",
	"runWorkspaceDiagnostics",
	"touchFile",
] as const;

type SiteEntry = { routes: readonly RouteId[] } | { exempt: string };

const LSP_DIAGNOSTICS_TOOL_ROUTES: readonly RouteId[] = [
	"lsp_diagnostics file",
	"lsp_diagnostics batch",
	"lsp_diagnostics directory",
	"lsp_diagnostics primary-only",
	"MCP pilens_diagnostics",
];

/**
 * Every derived site: the matrix routes that reach it, or why none does. The
 * key is `<file>#<enclosing declaration>:<member>` plus the site's
 * `clientScope` and `diagnostics` options as written.
 */
const SITE_REGISTRY: Record<string, SiteEntry> = {
	"clients/actionable-warnings.ts#buildActionableWarningsReport:getLastKnownDiagnostics":
		{
			exempt:
				"the in-band read of a file the turn already primed: it starts no server and returns the store an earlier touch filled; pinned by tests/tools/lsp-diagnostics-opengrep-disabled-4323.test.ts 'does not start Opengrep for a cold file read after a primed one'",
		},
	"clients/actionable-warnings.ts#enrichFileFromLsp:getDiagnostics": {
		routes: ["turn-end actionable warnings"],
	},
	"clients/dispatch/integration.ts#computeCascadeForFile:getAllDiagnostics": {
		exempt:
			"the cascade's snapshot of running clients' rows for import neighbours of a written file; it starts no server",
	},
	'clients/dispatch/integration.ts#computeCascadeForFile:touchFile{clientScope: "primary", diagnostics: "document"}':
		{
			exempt:
				"a cascade neighbour's primary-only re-check: its scope cannot select an auxiliary",
		},
	'clients/dispatch/integration.ts#computeCascadeForFile:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"a cascade neighbour's primary-only sync with no diagnostics: no auxiliary, no verdict",
		},
	'clients/dispatch/runners/lsp.ts#lspRunner:touchFile{clientScope: auxiliaryServerIds.length > 0 ? "with-auxiliary" : "primary", diagnostics: "document"}':
		{ routes: ["write-time dispatch"] },
	"clients/lsp/cascade-tier.ts#reconcileOutstandingCascadeTouches:getAllDiagnostics":
		{
			exempt:
				"an LSPClient's own getAllDiagnostics on a warm client (spawned.client), not the service: it starts nothing",
		},
	'clients/mcp/analyze.ts#warmLspForFile:touchFile{clientScope: "primary", diagnostics: "document"}':
		{
			exempt:
				"pilens_analyze's primary-only warm-up; its result is discarded and the dispatch runner (the write-time route's site) gives the verdict",
		},
	'clients/persistent-reverify.ts#runPersistentReverify:touchFile{clientScope: "primary", diagnostics: "document"}':
		{
			exempt:
				"the turn-end re-check of persistent warnings is primary-only: its scope cannot select an auxiliary",
		},
	"clients/pipeline.ts#resyncLspFile:getAuxiliaryClientsForFile": {
		routes: ["write-time dispatch"],
	},
	'clients/pipeline.ts#resyncLspFile:touchFile{clientScope: "primary", diagnostics: "none"}':
		{ routes: ["write-time dispatch"] },
	"clients/runtime-turn.ts#handleTurnEnd:readCachedDiagnosticsForServers": {
		exempt:
			"turn-end late coverage reads cached rows of the server ids the dispatch already named; it starts no server",
	},
	'clients/runtime-session.ts#igniteDominantLanguageWarm:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"session_start's primary-only warm-up with no diagnostics: no auxiliary, no verdict",
		},
	'clients/runtime-session.ts#igniteWarmFiles:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"session_start's configured warm files, primary-only with no diagnostics: no auxiliary, no verdict",
		},
	'clients/runtime-tool-call.ts#handleToolCallImpl:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"the pre-tool warm touch, primary-only with no diagnostics: no auxiliary, no verdict",
		},
	'clients/warm-attach.ts#serveRequest:touchFile{clientScope: "with-auxiliary", diagnostics: "document"}':
		{
			exempt:
				"the warm-attach incumbent serves another process's dispatch runner; with-auxiliary with no auxiliaryServerIds acquires no auxiliary (touchFile reads `auxiliaryServerIds ?? []`)",
		},
	"tools/lens-diagnostics.ts#formatFullMode:runWorkspaceDiagnostics": {
		routes: ["lens_diagnostics mode=full"],
	},
	"tools/lsp-diagnostics.ts#collectDiagnosticsForFile:getDiagnostics": {
		routes: LSP_DIAGNOSTICS_TOOL_ROUTES,
	},
	'tools/lsp-diagnostics.ts#collectDiagnosticsForFile:touchFile{clientScope: serverScope, diagnostics: "document"}':
		{ routes: LSP_DIAGNOSTICS_TOOL_ROUTES },
	"tools/lsp-navigation.ts#createLspNavigationTool:getAllDiagnostics": {
		exempt:
			"the path-less workspaceDiagnostics snapshot starts no server and claims no verdict; a switched-off server's rows are pinned out by tests/tools/lsp-diagnostics-opengrep-disabled-4323.test.ts 'leaves a running Opengrep's rows out of the path-less lsp_navigation snapshot'",
	},
	"tools/lsp-navigation.ts#createLspNavigationTool:getDiagnostics": {
		routes: ["lsp_navigation workspaceDiagnostics"],
	},
	'tools/lsp-navigation.ts#openFileBestEffort:touchFile{clientScope: waitForDiagnostics ? "all" : "primary", diagnostics: waitForDiagnostics ? "document" : "none"}':
		{ routes: ["lsp_navigation workspaceDiagnostics"] },
};

interface SourceFile {
	rel: string;
	source: string;
}

/** The production trees a route can live in; the service itself is excluded. */
function productionSources(): SourceFile[] {
	const files = [
		...["clients", "tools", "mcp"].flatMap((dir) =>
			listSourceFiles(path.join(repoRoot, dir)),
		),
		path.join(repoRoot, "index.ts"),
	];
	return files
		.map((file) => ({
			rel: relativePosix(repoRoot, file),
			source: fs.readFileSync(file, "utf8"),
		}))
		.filter((file) => file.rel !== "clients/lsp/index.ts");
}

/** `clientScope` and `diagnostics` as written in a call's last object argument. */
function selectorSuffix(call: SgNode | undefined): string {
	const options = call
		?.field("arguments")
		?.namedChildren()
		.filter((arg) => arg.kind() === "object")
		.at(-1);
	if (!options) return "";
	const parts: string[] = [];
	for (const pair of options.namedChildren()) {
		if (pair.kind() !== "pair") continue;
		const key = pair.field("key")?.text();
		if (key !== "clientScope" && key !== "diagnostics") continue;
		parts.push(`${key}: ${pair.field("value")?.text().replace(/\s+/g, " ")}`);
	}
	return parts.length > 0 ? `{${parts.sort().join(", ")}}` : "";
}

/**
 * Every read of a diagnostics entry member in `files`: a member expression
 * (`svc.touchFile(...)`, `svc?.getDiagnostics(...)`,
 * `const run = svc.runWorkspaceDiagnostics`) or a destructured name. A class's
 * own `this.<name>` is its own method, never the service, whose file is
 * excluded. Parsed from the AST, so a comment or a string is never a site.
 */
function deriveSites(
	files: readonly SourceFile[],
): Array<{ key: string; detail: string }> {
	const members = new Set<string>(DIAGNOSTICS_ENTRY_MEMBERS);
	const sites: Array<{ key: string; detail: string }> = [];
	for (const file of files) {
		if (!DIAGNOSTICS_ENTRY_MEMBERS.some((name) => file.source.includes(name)))
			continue;
		const lines = file.source.split("\n");
		const record = (node: SgNode, member: string, call?: SgNode) => {
			const line = node.range().start.line;
			const owner = findEnclosingSymbol(lines, line) ?? "(top level)";
			sites.push({
				key: `${file.rel}#${owner}:${member}${selectorSuffix(call)}`,
				detail: `${file.rel}:${line + 1}`,
			});
		};
		const visit = (node: SgNode): void => {
			const kind = node.kind();
			if (kind === "member_expression") {
				const member = node.field("property")?.text() ?? "";
				if (members.has(member) && node.field("object")?.kind() !== "this") {
					const parent = node.parent();
					const isCallee =
						parent?.kind() === "call_expression" &&
						parent.field("function")?.range().start.index ===
							node.range().start.index;
					record(node, member, isCallee ? parent : undefined);
				}
			} else if (
				kind === "shorthand_property_identifier_pattern" &&
				members.has(node.text())
			) {
				record(node, node.text());
			}
			for (const child of node.children()) visit(child);
		};
		visit(parse(Lang.TypeScript, file.source).root());
	}
	return sites;
}

/** Every problem with the derived sites against the registry and the matrix. */
function auditRoutes(
	scannedCount: number,
	sites: ReadonlyArray<{ key: string; detail: string }>,
	registry: Record<string, SiteEntry>,
	routes: readonly string[],
): string[] {
	const registered: string[] = [];
	const exemptions: Record<string, string> = {};
	for (const [key, entry] of Object.entries(registry)) {
		if ("routes" in entry) registered.push(key);
		else exemptions[key] = entry.exempt;
	}
	const problems = [
		...auditRegistry({
			sweepName: "diagnostics route derivation (#4403)",
			flagged: sites,
			registered,
			exemptions,
			minFlagged: 10,
			// 518 production files on 2026-10-14; a walk under half is blind.
			scannedCount,
			minScanned: 250,
			remediation:
				"A new read of an LSPService diagnostics member is a diagnostics route. Add it to ROUTES and drive it through the matrix, or exempt its key with the reason it cannot start a switched-off server or give a verdict.",
		}).problems,
	];
	// auditRegistry tolerates a registered key the scan no longer finds; a
	// route mapping is a claim about a live site, so a gone site is stale.
	const flagged = new Set(sites.map((site) => site.key));
	const stale = registered.filter((key) => !flagged.has(key));
	if (stale.length > 0) {
		problems.push(
			`registry routes name a site the scan no longer finds:\n${stale.map((key) => `  ${key}`).join("\n")}`,
		);
	}
	const named = new Set<string>();
	for (const [key, entry] of Object.entries(registry)) {
		if (!("routes" in entry)) continue;
		if (entry.routes.length === 0) problems.push(`${key}: names no route`);
		for (const route of entry.routes) {
			named.add(route);
			if (!routes.includes(route))
				problems.push(
					`${key}: names "${route}", which the matrix does not drive`,
				);
		}
	}
	for (const route of routes) {
		if (!named.has(route))
			problems.push(`matrix route "${route}" has no derived site`);
	}
	return problems;
}

describe("diagnostics routes are derived from code (#4403)", () => {
	it("maps every LSPService diagnostics read to a matrix route or a reasoned exemption", () => {
		const sources = productionSources();
		const problems = auditRoutes(
			sources.length,
			deriveSites(sources),
			SITE_REGISTRY,
			ROUTES,
		);

		expect(problems).toEqual([]);
	});

	it("reds a new route the matrix does not drive, and never reads one from a comment or a string", () => {
		// The fixture route: one real read, and two members named only in a
		// comment and a string (#4403: prose must not add or satisfy a site).
		const fixture: SourceFile = {
			rel: "tools/fixture-new-route.ts",
			source: [
				"export async function newRoute(svc: any, file: string) {",
				"\t// svc.touchFile(file, '', {}) is only prose here",
				"\tconst note = 'svc.getAllDiagnostics()';",
				"\treturn [note, await svc.getDiagnostics(file)];",
				"}",
				"",
			].join("\n"),
		};

		const sites = deriveSites([fixture]);
		const sources = productionSources();
		const problems = auditRoutes(
			sources.length,
			[...deriveSites(sources), ...sites],
			SITE_REGISTRY,
			ROUTES,
		);

		expect(sites.map((site) => site.key)).toEqual([
			"tools/fixture-new-route.ts#newRoute:getDiagnostics",
		]);
		expect(problems.join("\n")).toContain(
			"tools/fixture-new-route.ts#newRoute:getDiagnostics (tools/fixture-new-route.ts:4)",
		);
	});

	it("scans only names that are still methods of the LSP service", () => {
		// Read from the service's code with comments and strings blanked, so a
		// name kept alive only in prose does not count.
		const service = stripSource(
			fs.readFileSync(
				path.join(repoRoot, "clients", "lsp", "index.ts"),
				"utf8",
			),
		);

		expect(
			DIAGNOSTICS_ENTRY_MEMBERS.filter(
				(name) =>
					!new RegExp(`^\\t(?:async\\s+)?${name}\\s*\\(`, "m").test(service),
			),
		).toEqual([]);
	});

	it("keeps the MCP --no-opengrep cell inapplicable only while the flag has no environment spelling", () => {
		// createMcpHost resolves env, then config; a CLI-only flag cannot reach it.
		expect(getLensFlagSpec("no-opengrep")?.env).toBeUndefined();
	});
});

// #4403: the matrix's disabled and missing columns each have one cause. A file
// whose primaries mix the two must not be told only one of them.
describe("the primary-unavailable note's cause (#4403)", () => {
	it("names a disabled primary, an unstarted one, and both when they mix", async () => {
		const env = setupTestEnvironment(PREFIX);
		const workspace = fs.realpathSync(env.tmpDir);
		fs.mkdirSync(path.join(workspace, ".pi-lens"));
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({ disabledServers: ["json"] }),
		);
		const file = path.join(workspace, "probe.json");
		fs.writeFileSync(file, "{}\n");
		const trust = await import("../../clients/project-trust.js");
		const config = await import("../../clients/lsp/config.js");
		const { describePrimaryUnavailable } =
			await import("../../tools/lsp-diagnostics.js");
		trust.setProjectTrustState("trusted");
		try {
			await config.initLSPConfig(workspace);
			const note = (ids: string[]) =>
				describePrimaryUnavailable(
					undefined,
					{ unavailablePrimaryServerIds: ids },
					file,
				) ?? "";

			expect(note(["json"])).toContain(
				"(it is disabled in config by lsp.disabledServers)",
			);
			expect(note(["yaml"])).toContain(
				"(it could not be started, or was still starting)",
			);
			expect(note(["json", "yaml"])).toContain(
				"(it could not be started, was still starting, or is disabled in config by lsp.disabledServers)",
			);
		} finally {
			trust.resetProjectTrust();
			config.resetLSPConfigStateForTests();
		}
	});
});

describe("every diagnostics route under every server-selecting switch (#4403)", () => {
	afterAll(async () => {
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await getLSPService().shutdown();
			},
		});
	});

	for (const column of COLUMNS) {
		it(
			`starts the same servers and gives the same verdict on every route: ${column.id}`,
			async () => {
				const observed = await runColumn(column);

				expect(observed).toEqual(expectedRow(column));
			},
			180_000 * testTimeoutScale,
		);
	}

	it("declares divergences and inapplicable cells only for a real route and column", () => {
		const columns = new Set<string>(COLUMNS.map((column) => column.id));
		for (const row of [...KNOWN_VERDICT_DIVERGENCES, ...NOT_APPLICABLE]) {
			expect(ROUTES).toContain(row.route);
			expect(columns.has(row.column)).toBe(true);
		}
		for (const route of Object.keys({
			...NO_VERDICT_SURFACE,
			...NO_NOTE_SURFACE,
		}))
			expect(ROUTES).toContain(route);
	});
});
