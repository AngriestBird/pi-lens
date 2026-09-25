/**
 * #2939 M7 — `signal: deps.ctx.signal` on the `tool_call` complexity-baseline
 * bootstrap demand.
 *
 * Recurrence prevented: #2523 AC4. The ambient abort slot is published by
 * `tool_result`, AFTER this hook has already run, so at `tool_call` the hook's
 * own `ctx.signal` is the only live signal there is. Without it forwarded, a
 * user who presses Escape while the analyzer graph is still loading waits the
 * demand's whole `BOOTSTRAP_LOAD_TIMEOUT_MS` out before the tool call returns —
 * and the cancel then reaches the ledger as a `timeout`, which is exactly the
 * inversion `requestBootstrapClients`'s `unavailableReason !== "aborted"` guard
 * exists to prevent.
 *
 * PR #3411 round 1 DELETED this forwarding because the file's existing 26 cases
 * stayed green under the deletion: none of them drives the hook with an aborted
 * `ctx.signal` and a load still in flight. This case does, and reds.
 *
 * The bootstrap module is the shared production-faithful `bootstrapSeamMock`,
 * whose `requestBootstrapClients` consumes the caller's signal the way
 * production's `bounded()` does; its load is given a real (faked) delay so
 * "released by the signal" and "waited the load out" are two different
 * observable moments rather than one hang. Everything else — the runtime
 * coordinator, the cache manager, the baseline map — is real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadDelayMs = 30_000;

vi.mock("../../clients/lsp/index.js", async () => {
	const { makeLspServiceDouble } =
		await import("../support/lsp-service-double.js");
	return {
		getLSPService: () => makeLspServiceDouble({}),
		resetLSPService: () => {},
	};
});

vi.mock("../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
	return bootstrapSeamMock(
		() =>
			new Promise((resolve) =>
				setTimeout(
					() =>
						resolve({
							complexityClient: {
								isSupportedFile: () => true,
								analyzeFile: async () => ({
									maintainabilityIndex: 70,
									cognitiveComplexity: 1,
									maxNestingDepth: 1,
									linesOfCode: 1,
									maxCyclomaticComplexity: 1,
									codeEntropy: 0,
								}),
							},
							biomeClient: {},
							ruffClient: {},
							metricsClient: {},
						}),
					loadDelayMs,
				),
			),
	);
});

import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let filePath: string;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-2939-escape-");
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	filePath = createTempFile(
		env.tmpDir,
		"baselined.ts",
		"export const a = 1;\n",
	);
});

afterEach(() => {
	vi.useRealTimers();
	env.cleanup();
});

function deps(signal: AbortSignal) {
	return {
		event: { toolName: "read", input: { path: filePath } },
		ctx: { signal, cwd: env.tmpDir },
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
	} as unknown as Parameters<typeof handleToolCall>[0];
}

describe("#2939 M7 — Escape releases the complexity-baseline demand", () => {
	it("returns without waiting the bootstrap load out when the hook signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		vi.useFakeTimers();

		let settled = false;
		const call = handleToolCall(deps(controller.signal)).then(() => {
			settled = true;
		});
		// Zero fake time: only microtasks. With the signal forwarded the demand
		// fails open immediately, so the hook is already done.
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true);
		expect(runtime.complexityBaselines.size).toBe(0);

		// Drain the abandoned load so nothing dangles into the next case.
		await vi.advanceTimersByTimeAsync(loadDelayMs);
		await call;
	});

	it("still takes the baseline when the hook signal is live", async () => {
		// The inverse direction: a live signal must not short-circuit the demand.
		vi.useFakeTimers();
		const call = handleToolCall(deps(new AbortController().signal));
		await vi.advanceTimersByTimeAsync(loadDelayMs);
		await call;

		expect(runtime.complexityBaselines.size).toBe(1);
	});
});
