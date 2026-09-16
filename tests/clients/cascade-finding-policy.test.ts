/**
 * #3102 member 2: `buildResolvedFoundCascadeRun` (clients/cascade-format.ts)
 * formatted a cold neighbour's ERROR diagnostics into the turn-end cascade run
 * with no disposition filter, no `.pi-lens.json` rule policy and no inline
 * `pi-lens-ignore` suppression — so a neighbour error the agent had marked
 * `false-positive` came back on the quiet-window reconcile path every time the
 * neighbour's server answered after its cascade touch skipped the in-lane wait
 * (#1023/#1444's `resolved-found` outcome).
 *
 * The chain under test is the production one, in the order index.ts wires it:
 * `reconcileOutstandingCascadeTouches` (quiet window) →
 * `buildResolvedFoundCascadeRun` → `runtime.appendCascadeRun` →
 * `handleTurnEnd` → the agent-visible turn-end findings.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { buildResolvedFoundCascadeRun } from "../../clients/cascade-format.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import type { LSPDiagnostic } from "../../clients/lsp/client.js";
import {
	_resetOutstandingCascadeTouchesForTests,
	recordOutstandingCascadeTouch,
	reconcileOutstandingCascadeTouches,
} from "../../clients/lsp/cascade-tier.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const MARKED_MESSAGE = "cold neighbour error the agent dismissed";
const OTHER_MESSAGE = "cold neighbour error nobody marked";
const NEIGHBOR_BODY = "const marked = 1;\nconst other = 2;\n";

/** The identity `convertLspDiagnostics` gives a primary language-server
 * finding, and therefore the spelling of a mark made on any other surface. */
const CANONICAL_MARK = { tool: "lsp", rule: "typescript:2345" };

function errorDiag(
	line: number,
	message: string,
	code: number | string = 2345,
): LSPDiagnostic {
	return {
		severity: 1,
		message,
		source: "typescript",
		code,
		range: { start: { line, character: 0 }, end: { line, character: 5 } },
	};
}

let env: { tmpDir: string; cleanup: () => void };
let primary: string;
let neighbor: string;
let previousDataDir: string | undefined;

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

/**
 * The quiet-window reconcile exactly as index.ts's `onResolvedFound` runs it,
 * followed by the turn_end that delivers the appended run. Returns the
 * agent-visible turn-end content.
 */
async function reconcileAndDeliver(diags: LSPDiagnostic[]): Promise<string> {
	const runtime = new RuntimeCoordinator();
	const cacheManager = new CacheManager(false);
	recordOutstandingCascadeTouch({
		filePath: neighbor,
		serverId: "typescript",
		touchedAt: Date.now() - 50,
	});
	const outcomes = await reconcileOutstandingCascadeTouches({
		getWarmClientForFile: async () => ({
			client: {
				serverId: "typescript",
				getAllDiagnostics: () =>
					new Map([[normalizeMapKey(neighbor), { ts: Date.now(), diags }]]),
			},
		}),
	} as never);
	expect(outcomes[0]?.outcome).toBe("resolved-found");
	const run = buildResolvedFoundCascadeRun(env.tmpDir, {
		filePath: neighbor,
		diagnostics: outcomes[0]?.diagnostics ?? [],
	});
	if (run) runtime.appendCascadeRun(run);

	runtime.beginTurn();
	cacheManager.addModifiedRange(
		primary,
		{ start: 1, end: 1 },
		false,
		env.tmpDir,
	);
	await handleTurnEnd({
		ctxCwd: env.tmpDir,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as never);
	return (
		consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]?.content ?? ""
	);
}

async function mark(params: Record<string, unknown>) {
	const { createLensDiagnosticMarkTool } =
		await import("../../tools/lens-diagnostic-mark.js");
	const markTool = createLensDiagnosticMarkTool(() => env.tmpDir);
	return markTool.execute("mark-3102", params, undefined, () => {}, {
		cwd: env.tmpDir,
	});
}

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-3102-cascade-");
	primary = path.join(env.tmpDir, "primary.ts");
	neighbor = path.join(env.tmpDir, "neighbor.ts");
	fs.writeFileSync(primary, "export const x = 1;\n");
	fs.writeFileSync(neighbor, NEIGHBOR_BODY);
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	_resetOutstandingCascadeTouchesForTests();
	_resetDeferredForTests();
	_resetStateCacheForTests();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetOutstandingCascadeTouchesForTests();
	_resetDeferredForTests();
	_resetStateCacheForTests();
	removeTempDirSync(env.tmpDir);
	env.cleanup();
});

describe("cold-neighbour cascade run applies the finding policy (#3102)", () => {
	it("premise: both neighbour errors reach the agent before anything is marked", async () => {
		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		expect(content).toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a neighbour error marked false-positive", async () => {
		const marked = await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();

		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a neighbour error marked from the cascade run's own rendering, which prints no tool", async () => {
		// The cascade line is `line N, col M rule=<rule>: <message>` — no tool
		// for the agent to pass on, and `lens_diagnostic_mark`'s `tool` is
		// optional.
		const marked = await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			rule: "typescript:2345",
			disposition: "false-positive",
		});
		expect(marked.isError).toBeFalsy();

		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a rule the project disabled in .pi-lens.json", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, ".pi-lens.json"),
			JSON.stringify({ rules: { ts: { disable: ["typescript:2345"] } } }),
		);
		const content = await reconcileAndDeliver([
			errorDiag(0, MARKED_MESSAGE),
			errorDiag(1, OTHER_MESSAGE, 2304),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("drops a neighbour error an inline pi-lens-ignore comment suppresses", async () => {
		fs.writeFileSync(
			neighbor,
			"// pi-lens-ignore: typescript:2345\nconst marked = 1;\nconst other = 2;\n",
		);
		const content = await reconcileAndDeliver([
			errorDiag(1, MARKED_MESSAGE),
			errorDiag(2, OTHER_MESSAGE, 2304),
		]);
		expect(content).not.toContain(MARKED_MESSAGE);
		expect(content).toContain(OTHER_MESSAGE);
	});

	it("builds no cascade run at all when every neighbour error was suppressed", async () => {
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const content = await reconcileAndDeliver([errorDiag(0, MARKED_MESSAGE)]);
		expect(content).not.toContain("cold neighbor");
		expect(content).not.toContain(MARKED_MESSAGE);
	});

	it("keeps neighbour errors visible when the file cannot be read (fail open)", async () => {
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED_MESSAGE,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		// A STRICT false-positive anchor hashes the finding's own line, so with
		// no content it cannot match — the finding stays VISIBLE rather than
		// being hidden on an I/O error (AGENTS.md shape 48).
		fs.rmSync(neighbor);
		fs.mkdirSync(neighbor);

		const content = await reconcileAndDeliver([errorDiag(0, MARKED_MESSAGE)]);
		expect(content).toContain(MARKED_MESSAGE);
	});
});
