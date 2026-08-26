import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	classifyObservedRunner,
	COLLECT_LATER_THRESHOLD_MS,
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../../../clients/dispatch/collect-later-tier.js";
import {
	drainPendingRunnerFindings,
	resetPendingRunnerFindings,
} from "../../../clients/dispatch/pending-runner-findings.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { RunnerResult } from "../../../clients/dispatch/types.js";

describe("observed runner collect-later tier (#2116)", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-lens-runner-tier-"));
	const filePath = join(projectRoot, "fixture.ts");

	beforeEach(() => {
		resetObservedRunnerLatency();
		resetPendingRunnerFindings();
		writeFileSync(filePath, "const fixture = 1;\n");
	});

	it("moves a previously slow runner off the edit result and delivers its finding at turn end", async () => {
		observeRunnerLatency({
			projectRoot,
			runnerId: "fixture-runner",
			durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
		});
		let resolve!: (result: RunnerResult) => void;
		const completed = new Promise<RunnerResult>((r) => (resolve = r));
		const registry = new RunnerRegistry();
		registry.register({
			id: "fixture-runner",
			appliesTo: ["jsts"],
			priority: 1,
			enabledByDefault: true,
			run: async () => completed,
		});
		const ctx = createDispatchContext(
			filePath,
			projectRoot,
			{ getFlag: () => false },
			new FactStore(),
		);
		Object.defineProperty(ctx, "writeIndex", { value: 1 });
		expect(
			classifyObservedRunner(ctx.projectRoot ?? ctx.cwd, "fixture-runner"),
		).toBe("collect-later");

		const edit = await Promise.race([
			dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["fixture-runner"] }],
				registry,
			),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("edit waited for deferred runner")),
					100,
				),
			),
		]);
		expect(edit.diagnostics).toEqual([]);

		resolve({
			status: "succeeded",
			diagnostics: [
				{
					id: "fixture-finding",
					message: "late finding",
					filePath,
					tool: "fixture-runner",
					severity: "warning",
					semantic: "warning",
				},
			],
			semantic: "warning",
		});
		const late = await drainPendingRunnerFindings(100);
		expect(late).toHaveLength(1);
		expect(late[0]?.result?.diagnostics[0]?.id).toBe("fixture-finding");
	}, 20_000);

	it("recovers to inline after a fast observed run", () => {
		expect(classifyObservedRunner(projectRoot, "fixture-runner")).toBe(
			"inline",
		);
		expect(
			observeRunnerLatency({
				projectRoot,
				runnerId: "fixture-runner",
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			}),
		).toBe("collect-later");
		expect(
			observeRunnerLatency({
				projectRoot,
				runnerId: "fixture-runner",
				durationMs: 1,
			}),
		).toBe("inline");
	});
});
