/**
 * #3867: the analyze coverage notice keys on the runner OUTCOME, not the bare
 * `status`. A primary runner that timed out or failed to spawn reports
 * `status: "failed"` but produced no usable result — it did not analyse the
 * file, so the pull must still carry the coverage notice. Only a `failed` run
 * whose own findings failed it (`failureKind: "blocking_diagnostics"`, the
 * `hasUsableResult` contract in clients/dispatch/types.ts) counts as coverage,
 * beside a plain `succeeded` run.
 *
 * Drives the real `dispatchForFile` — the entry the MCP `pilens_analyze` pull
 * uses with `dedupeCoverageNotice: false` — with a single primary (`lsp`)
 * runner and no fallback linters, so the coverage decision is the only thing
 * under test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCoverageNoticeState,
	clearLatencyReports,
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type {
	RunnerGroup,
	RunnerResult,
} from "../../../clients/dispatch/types.js";

const COVERAGE_NOTICE = "Pi-lens jsts analysis unavailable";

describe("coverage notice keys on the primary runner's usable result (#3867)", () => {
	let registry: RunnerRegistry;
	const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["lsp"] }];

	// The pull surface: every call is a deliberate question, so the notice must
	// come back every time (no session latch) — see buildCoverageNotice.
	const pull = (ctx: Parameters<typeof dispatchForFile>[0]) =>
		dispatchForFile(ctx, groups, registry, undefined, {
			dedupeCoverageNotice: false,
		});

	function context() {
		return createDispatchContext(
			"test.ts",
			"/project",
			{ getFlag: () => false },
			new FactStore(),
		);
	}

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
		clearLatencyReports();
	});

	it("carries the notice when the only primary runner timed out", async () => {
		// Fake timers drive the dispatcher's timeout; no real wall-clock wait
		// enters the test. `vi.useFakeTimers` precedes the never-settling promise
		// so the flake-shape scan reads it as a faked timer scope.
		vi.useFakeTimers();
		try {
			// Never resolves: only the dispatcher's runner timeout settles it, so
			// the latency row is a real `failed`/`failureKind: "timeout"`.
			registry.register({
				id: "lsp",
				appliesTo: ["jsts"],
				priority: 4,
				timeoutMs: 1,
				async run(): Promise<RunnerResult> {
					return new Promise(() => {});
				},
			});

			const pending = pull(context());
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			// Let the pipeline reach the runner race, then fire its timeout timer.
			for (let i = 0; i < 100 && !settled; i += 1) {
				await vi.advanceTimersByTimeAsync(1);
			}
			const result = await pending;

			expect(result.output).toContain(COVERAGE_NOTICE);
			expect(result.warnings.map((w) => w.message)).toContainEqual(
				expect.stringContaining(COVERAGE_NOTICE),
			);
		} finally {
			vi.useRealTimers();
		}
	}, 500);

	it("carries the notice when the only primary runner failed to spawn", async () => {
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				throw new Error("spawn lsp ENOENT");
			},
		});

		const result = await pull(context());

		expect(result.output).toContain(COVERAGE_NOTICE);
	});

	it("does not carry the notice when the primary runner's findings failed it", async () => {
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "lsp-blocker",
							message: "Type error",
							filePath: "test.ts",
							severity: "error",
							semantic: "blocking",
							tool: "lsp",
						},
					],
					semantic: "blocking",
					failureKind: "blocking_diagnostics",
				};
			},
		});

		const result = await pull(context());

		expect(result.output).not.toContain(COVERAGE_NOTICE);
	});

	it("does not carry the notice when the primary runner succeeded", async () => {
		registry.register({
			id: "lsp",
			appliesTo: ["jsts"],
			priority: 4,
			async run(): Promise<RunnerResult> {
				return { status: "succeeded", diagnostics: [], semantic: "none" };
			},
		});

		const result = await pull(context());

		expect(result.output).not.toContain(COVERAGE_NOTICE);
	});
});
