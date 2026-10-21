/**
 * #4484 round 3, R1: a run has a verdict only when it read the file and
 * finished. A skip states a not-applicable reason from the closed taxonomy, or
 * it reached no verdict.
 *
 * Recurrence: `reachedNoVerdict` read every skip without an unavailable
 * primary as a verdict, so the LSP line-limit skip, the ast-grep size-cap skip
 * and the tree-sitter WASM-abort skip retired recorded blockers (review probes
 * P1 to P3, TLC MutSkipVerdict).
 */
import { describe, expect, it } from "vitest";
import type { RunnerLatency } from "../../../clients/dispatch/dispatcher.js";
import {
	RUNNER_SKIP_REASONS,
	checkedWholeFile,
	reachedNoVerdict,
} from "../../../clients/dispatch/types.js";

describe("reachedNoVerdict (#4484 round 3)", () => {
	it("reads a skip with a stated not-applicable reason as a verdict", () => {
		for (const skipReason of RUNNER_SKIP_REASONS) {
			expect(reachedNoVerdict({ status: "skipped", skipReason })).toBe(false);
		}
	});

	it("reads a skip without a stated reason as no verdict", () => {
		expect(reachedNoVerdict({ status: "skipped" })).toBe(true);
	});

	it("reads a skip naming a reason outside the taxonomy as no verdict", () => {
		expect(
			reachedNoVerdict({
				status: "skipped",
				skipReason: "file-too-large" as never,
			}),
		).toBe(true);
	});
});

/** One dispatch's verdict fields, from its runners' latency rows. */
function dispatchOf(
	runners: Array<[string, RunnerLatency["status"]]>,
	extra: Parameters<typeof checkedWholeFile>[0] = {},
): Parameters<typeof checkedWholeFile>[0] {
	const noVerdict = runners
		.filter(([, status]) => status !== "succeeded")
		.map(([runnerId]) => runnerId);
	return {
		latencyReport: {
			filePath: "/p/a.ts",
			fileKind: "jsts",
			overallStartMs: 0,
			overallEndMs: 0,
			totalDurationMs: 0,
			runners: runners.map(([runnerId, status]) => ({
				runnerId,
				startTime: 0,
				endTime: 0,
				durationMs: 0,
				status,
				diagnosticCount: 0,
				semantic: "none",
			})),
			stoppedEarly: false,
			totalDiagnostics: 0,
			blockers: 0,
			warnings: 0,
		},
		...(noVerdict.length > 0 && {
			inconclusiveSources: {
				runnerIds: noVerdict,
				serverIds: [],
				collectLaterRunnerIds: [],
			},
		}),
		...extra,
	};
}

describe("checkedWholeFile (#4733 r1 F2)", () => {
	it("admits only a dispatch whose every running runner answered over the whole file", () => {
		// RECURRENCE GUARDED: #4733 r1 F2. A clean write with no verdict (a
		// runner that timed out, a server that never answered, a coverage gap)
		// dropped another session's blocker section for the file; only a write
		// this predicate admits may.
		const cells: Array<
			[string, Parameters<typeof checkedWholeFile>[0], boolean]
		> = [
			["every runner answered", dispatchOf([["biome", "succeeded"]]), true],
			[
				"a runner skipped here (no config or tool)",
				dispatchOf([
					["biome", "succeeded"],
					["eslint", "skipped"],
				]),
				true,
			],
			[
				"a collect-later run still in flight",
				dispatchOf([
					["biome", "succeeded"],
					["tsc", "pending"],
				]),
				true,
			],
			[
				"a runner failed or timed out",
				dispatchOf([
					["biome", "succeeded"],
					["eslint", "failed"],
				]),
				false,
			],
			[
				"a runner answered but broke part way",
				{
					...dispatchOf([["tree-sitter", "succeeded"]]),
					inconclusiveSources: {
						runnerIds: ["tree-sitter"],
						serverIds: [],
						collectLaterRunnerIds: [],
					},
				},
				false,
			],
			[
				"a no-verdict runner with no latency row",
				{
					...dispatchOf([["biome", "succeeded"]]),
					inconclusiveSources: {
						runnerIds: ["eslint"],
						serverIds: [],
						collectLaterRunnerIds: [],
					},
				},
				false,
			],
			[
				"a language server went unanswered",
				dispatchOf([["lsp", "succeeded"]], {
					inconclusiveSources: {
						runnerIds: [],
						serverIds: ["typescript"],
						collectLaterRunnerIds: [],
					},
				}),
				false,
			],
			[
				"the primary group did not check the file",
				dispatchOf([["biome", "succeeded"]], {
					unconfirmedStatus: "not fully checked",
				}),
				false,
			],
			[
				"a verdict covers only the edit",
				dispatchOf([["biome", "succeeded"]], {
					editScopedRunnerIds: ["ast-grep-napi"],
				}),
				false,
			],
			["no runner ran at all", dispatchOf([["eslint", "skipped"]]), false],
			["no latency report", {}, false],
		];
		expect(
			cells.map(([label, result]) => [label, checkedWholeFile(result)]),
		).toEqual(cells.map(([label, , want]) => [label, want]));
	});
});
