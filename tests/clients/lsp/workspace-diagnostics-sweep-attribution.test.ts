/**
 * #1723 residual: the workspace-diagnostics sweep's per-file touch is
 * bracketed, so a block that fires DURING it has a name.
 *
 * PR #1805 wired in-flight phase attribution at the dispatcher's `runRunner`
 * chokepoint and named this second site as a deferred gap. It is not a
 * hypothetical one: the 18 270 ms block in #1723's own reproduction carries
 * `lastPhase: lsp_workspace_diagnostics`, i.e. the sweep's own COMPLETION
 * record. `lastPhase` names a phase that already finished, so the sweep could
 * only ever appear in a loop_block record AFTER it stopped being the culprit.
 *
 * `getPhaseForWindow` (clients/latency-logger.ts) reads live and
 * recently-closed brackets. Without a bracket around `processFile`, a block
 * inside the sweep overlaps nothing and the record is anonymous.
 *
 * These drive the REAL `runWorkspaceDiagnostics` and observe the bracket from
 * inside the touch — the instant a synchronous block would fire — rather than
 * calling `phaseStarted` directly, which would pin nothing about the wiring.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetWorkspaceDiagnosticsCacheSession } from "../../../clients/lsp/workspace-diagnostics-session.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

// Only server selection and client creation are stubbed, so no language server
// is spawned. Everything the sweep itself does is the real code path.
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: () => undefined,
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

/**
 * Cold `import("clients/lsp/index.js")` after `vi.resetModules()` is heavy —
 * the same cost tests/index-loop-block-wiring.test.ts documents and budgets
 * for. 30s matches that file's convention.
 */
const SWEEP_ATTRIBUTION_TIMEOUT_MS = 30_000;

/**
 * Hold the loop synchronously for `ms`. This is the SHAPE the feature exists
 * for — a block inside the sweep — and it also makes the read below
 * deterministic: `getPhaseForWindow` rejects a bracket whose elapsed time is
 * under 5% of the window length (MIN_PLAUSIBLE_ELAPSED_FRACTION), and a
 * bracket read microseconds after it opened trips that floor on a fast host.
 */
function blockFor(ms: number): void {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		// deliberately empty: a real synchronous block
	}
}

describe(
	"#1723 sweep per-file touch is attributable",
	{
		timeout: SWEEP_ATTRIBUTION_TIMEOUT_MS,
	},
	() => {
		let sessionDir: string;
		let fileA: string;
		let fileB: string;
		/** Runs INSIDE the sweep's touch, where a synchronous block would land. */
		let duringTouch: (() => void) | undefined;

		beforeEach(() => {
			vi.resetModules();
			getServersForFileWithConfig.mockReset();
			createLSPClient.mockReset();
			duringTouch = undefined;

			sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-1723-"));
			fs.mkdirSync(path.join(sessionDir, ".pi-lens"));
			fileA = path.join(sessionDir, "a.ts");
			fileB = path.join(sessionDir, "b.ts");
			fs.writeFileSync(fileA, "export const a = 1;\n");
			fs.writeFileSync(fileB, "export const b = 2;\n");

			const tsServer = {
				id: "typescript",
				name: "typescript",
				extensions: [".ts"],
				root: async () => sessionDir,
				spawn: vi.fn(async () => ({ process: {}, source: "test" })),
			};
			getServersForFileWithConfig.mockImplementation((fp: string) =>
				fp.endsWith(".ts") ? [tsServer] : [],
			);
			createLSPClient.mockResolvedValue({
				isAlive: () => true,
				shutdown: async () => {},
				serverId: "typescript",
				root: sessionDir,
				getWorkspaceDiagnosticsSupport: () => ({ advertised: false }),
				getOperationSupport: () => ({}),
				notify: { open: vi.fn(async () => {}) },
				waitForDiagnostics: vi.fn(async () => {
					duringTouch?.();
				}),
				getDiagnostics: vi.fn(() => []),
			});
		});

		afterEach(async () => {
			const roots = await import("../../../clients/lsp/session-roots.js");
			roots.resetSessionRootsForTests();
			removeTempDirSync(sessionDir);
			resetWorkspaceDiagnosticsCacheSession();
		});

		/**
		 * Build the module graph for ONE test, then register the session root
		 * through the SAME graph `index.js` closes over — the pattern
		 * workspace-diagnostics-outside-root.test.ts establishes and explains.
		 * `latency-logger` is imported here too so the observations below read the
		 * instance the service actually writes to.
		 */
		async function loadService() {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const roots = await import("../../../clients/lsp/session-roots.js");
			const latency = await import("../../../clients/latency-logger.js");
			roots.resetSessionRootsForTests();
			roots.registerSessionRoot(sessionDir);
			latency.resetCurrentPhaseForSession();
			return { service: new LSPService(), latency };
		}

		it("names the sweep as the in-flight phase while a file's touch is running", async () => {
			const { service, latency } = await loadService();
			let observed: string | undefined;
			duringTouch = () => {
				observed = latency.getCurrentPhase()?.phase;
			};

			await service.runWorkspaceDiagnostics(sessionDir, { files: [fileA] });

			// Pre-fix: undefined. Nothing brackets the sweep's touch, so a block
			// during it overlaps no live bracket and the loop_block record is
			// anonymous — exactly #1723's 18 270 ms reproduction.
			expect(observed).toBe("lsp_workspace_diagnostics_touch");
		});

		it("a block whose window lands inside the sweep is attributed to it", async () => {
			const { service, latency } = await loadService();
			let attribution: ReturnType<typeof latency.getPhaseForWindow>;
			duringTouch = () => {
				// Block for real, then read exactly as turn_end does: overlap the
				// block's own time window against live and recently-closed brackets.
				const blockMs = 30;
				blockFor(blockMs);
				const now = Date.now();
				attribution = latency.getPhaseForWindow(now - blockMs, now);
			};

			await service.runWorkspaceDiagnostics(sessionDir, { files: [fileA] });

			expect(attribution?.phase).toBe("lsp_workspace_diagnostics_touch");
			expect(attribution?.stillRunning).toBe(true);
		});

		it("closes every bracket, so a later block is not blamed on a finished sweep", async () => {
			const { service, latency } = await loadService();

			await service.runWorkspaceDiagnostics(sessionDir, {
				files: [fileA, fileB],
			});

			// Mutation guard for the `finally`: drop it and each file leaks a live
			// bracket that misattributes every later loop_block to a sweep that
			// already ended — `phaseFinished`'s own documented failure mode.
			expect(latency.getCurrentPhase()).toBeUndefined();
		});

		it("closes the bracket even when the file's touch throws", async () => {
			const { service, latency } = await loadService();
			duringTouch = () => {
				throw new Error("server died mid-touch");
			};

			await service.runWorkspaceDiagnostics(sessionDir, { files: [fileA] });

			// The error path is the one a bare `phaseFinished` after the try/catch
			// would still cover, but an early `return` inside the try would not —
			// hence `finally`, and hence this case.
			expect(latency.getCurrentPhase()).toBeUndefined();
		});
	},
);
