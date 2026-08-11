/**
 * session: drives pi-lens's real lifecycle handlers for the MCP path. The
 * handlers (handleSessionStart/handleTurnEnd) and the bootstrap bundle are
 * mocked — this asserts the deps wiring, the consume-bridge → tool result, and
 * that turn_end registers edited files into turn state.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../../clients/cache-manager.js";
import { removeTempDirSync } from "../test-utils.js";

const handleSessionStart = vi.hoisted(() =>
	vi.fn(async (_deps: unknown) => undefined),
);
const handleTurnEnd = vi.hoisted(() =>
	vi.fn(async (_deps: unknown) => undefined),
);
const stubClients = vi.hoisted(() => {
	const keys = [
		"ruffClient",
		"biomeClient",
		"knipClient",
		"todoScanner",
		"jscpdClient",
		"depChecker",
		"testRunnerClient",
		"metricsClient",
		"complexityClient",
		"goClient",
		"govulncheckClient",
		"gitleaksClient",
		"trivyClient",
		"opengrepClient",
		"rustClient",
		"agentBehaviorClient",
	];
	return Object.fromEntries(keys.map((k) => [k, { __stub: k }]));
});

vi.mock("../../../clients/runtime-session.js", () => ({ handleSessionStart }));
vi.mock("../../../clients/runtime-turn.js", () => ({ handleTurnEnd }));
vi.mock("../../../clients/bootstrap.js", () => ({
	loadBootstrapClients: async () => stubClients,
}));
vi.mock("../../../clients/ast-grep-client.js", () => ({
	AstGrepClient: class {},
}));
vi.mock("../../../clients/lsp/index.js", () => ({
	getLSPService: () => ({ getAliveClientCount: () => 2 }),
	resetLSPService: vi.fn(),
}));
vi.mock("../../../clients/runtime-context.js", () => ({
	consumeSessionStartGuidance: vi.fn(() => ({
		messages: [{ role: "user", content: "PROJECT GUIDANCE" }],
	})),
	consumeTurnEndFindings: vi.fn(() => ({
		messages: [{ role: "user", content: "TURN ADVISORY" }],
	})),
	peekTurnEndFindings: vi.fn(() => ({
		messages: [{ role: "user", content: "TURN ADVISORY" }],
	})),
	consumeTestFindings: vi.fn(() => ({
		messages: [{ role: "user", content: "TESTS FAILED" }],
	})),
	peekTestFindings: vi.fn(() => ({
		messages: [{ role: "user", content: "TESTS FAILED" }],
	})),
}));

import {
	_resetMcpSessionContext,
	_resetTurnEndChain,
	runSessionStart,
	runTurnEnd,
	runTurnEndForIpc,
} from "../../../clients/mcp/session.js";

let tmpDir: string;

beforeEach(() => {
	handleSessionStart.mockClear();
	handleTurnEnd.mockClear();
	_resetMcpSessionContext();
	_resetTurnEndChain();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-session-"));
});

afterEach(() => {
	removeTempDirSync(tmpDir);
});

describe("runSessionStart", () => {
	it("forwards a complete deps bundle to handleSessionStart", async () => {
		await runSessionStart(tmpDir);

		expect(handleSessionStart).toHaveBeenCalledTimes(1);
		const deps = handleSessionStart.mock.calls[0][0] as Record<string, unknown>;
		expect(deps.ctxCwd).toBe(tmpDir);
		expect(typeof deps.getFlag).toBe("function");
		expect(deps.cacheManager).toBeDefined();
		expect(deps.runtime).toBeDefined();
		// Bootstrap clients are wired through from the bundle.
		expect(deps.knipClient).toBe(stubClients.knipClient);
		expect(deps.jscpdClient).toBe(stubClients.jscpdClient);
		expect(deps.testRunnerClient).toBe(stubClients.testRunnerClient);
		expect(typeof deps.resetDispatchBaselines).toBe("function");
	});

	it("returns the consumed guidance and LSP client count", async () => {
		const outcome = await runSessionStart(tmpDir);
		expect(outcome.guidance).toBe("PROJECT GUIDANCE");
		expect(outcome.aliveLspClients).toBe(2);
		// No baseline computed yet on a fresh RuntimeCoordinator.
		expect(outcome.errorDebtBaseline).toBeUndefined();
	});
});

describe("runTurnEnd", () => {
	it("registers edited files into turn state and returns findings", async () => {
		const file = path.join(tmpDir, "edited.ts");
		fs.writeFileSync(file, "export const a = 1;\nexport const b = 2;\n");

		const outcome = await runTurnEnd(tmpDir, [file]);

		expect(handleTurnEnd).toHaveBeenCalledTimes(1);
		expect(outcome.filesRegistered).toBe(1);
		expect(outcome.turnEnd).toBe("TURN ADVISORY");
		expect(outcome.tests).toBe("TESTS FAILED");

		// The file was written into turn state for the handler to pick up.
		const deps = handleTurnEnd.mock.calls[0][0] as {
			cacheManager: { readTurnState: (cwd: string) => { files: object } };
		};
		const turnState = deps.cacheManager.readTurnState(tmpDir);
		expect(Object.keys(turnState.files).length).toBe(1);
	});

	it("skips unreadable files without counting them", async () => {
		const outcome = await runTurnEnd(tmpDir, [
			path.join(tmpDir, "does-not-exist.ts"),
		]);
		expect(outcome.filesRegistered).toBe(0);
		expect(handleTurnEnd).toHaveBeenCalledTimes(1);
	});

	it("rolls the worklist back when the Stop reply is not acknowledged (#1218)", async () => {
		const file = path.join(tmpDir, "timeout.ts");
		fs.writeFileSync(file, "export const timeout = true;\n");
		new CacheManager().addModifiedRange(
			file,
			{ start: 1, end: 1 },
			true,
			tmpDir,
			"mcp-test",
		);

		const outcome = await runTurnEndForIpc(tmpDir, async () => false);
		expect(outcome.turnEnd).toBe("TURN ADVISORY");
		expect(outcome.tests).toBe("TESTS FAILED");
		expect(new CacheManager().readTurnState(tmpDir).files).toHaveProperty(
			"timeout.ts",
		);
		// The transaction itself was allowed to finish, but delivery state remains
		// owned by the next authorized Stop rather than being consumed here.
		expect(outcome.filesRegistered).toBe(0);
	});

	it("commits finding delivery only after the Stop reply is acknowledged", async () => {
		const outcome = await runTurnEndForIpc(tmpDir, async () => true);
		expect(outcome.turnEnd).toBe("TURN ADVISORY");
		expect(outcome.tests).toBe("TESTS FAILED");
	});

	// Two concurrent handleTurnEnds share one RuntimeCoordinator/CacheManager and
	// race the turn-state clear. The MCP tool and the Stop hook's IPC route both
	// land here, and a hook killed at Claude Code's timeout leaves the pass running.
	it("serializes overlapping passes instead of running them concurrently", async () => {
		let release: (() => void) | undefined;
		handleTurnEnd.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					release = () => resolve(undefined);
				}),
		);

		const first = runTurnEnd(tmpDir);
		const second = runTurnEnd(tmpDir);
		await vi.waitFor(() => expect(release).toBeDefined());
		expect(handleTurnEnd).toHaveBeenCalledTimes(1);

		release?.();
		await Promise.all([first, second]);
		expect(handleTurnEnd).toHaveBeenCalledTimes(2);
	});

	// The chain is a module-level promise every caller links onto, so a thrown
	// pass must be absorbed before it becomes the next caller's link. Without the
	// reset, one failed turn_end rejects every later Stop hook with the PREVIOUS
	// turn's error and never runs the pass at all — a warm server that quietly
	// stops checking for the rest of the session.
	it("keeps serving callers after a pass rejects", async () => {
		handleTurnEnd.mockRejectedValueOnce(new Error("pass blew up"));

		await expect(runTurnEnd(tmpDir)).rejects.toThrow("pass blew up");
		const outcome = await runTurnEnd(tmpDir);

		expect(handleTurnEnd).toHaveBeenCalledTimes(2);
		expect(outcome.turnEnd).toBe("TURN ADVISORY");
	});
});
