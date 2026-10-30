/**
 * #5020 — a row of an inline-blocker record that names ANOTHER file retires on
 * the cited file's own state, and only on it.
 *
 * Recurrence: helm-lint reports `templates/other-b.yaml` while the agent wrote
 * `templates/deploy-a.yaml`, so the row sits in deploy-a's record. Fixing or
 * deleting other-b never re-dispatched deploy-a, so the record, and the commit
 * gate behind it, outlived the cause. These cases drive the coordinator seam
 * (`retireForeignRows`, `retireForeignRowsOfMissingFiles`) for the rules the
 * tool_result witness in `tests/index-3190-inline-blocker-deleted-path-witness.test.ts`
 * cannot reach: the ordering token, the own-row and no-structure refusals, the
 * rebuilt derived fields, and the project-root resolution of a relative cite.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { verdictRunnerIds } from "../../clients/dispatch/types.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

function row(
	filePath: string,
	line: number,
	tool: string,
	runnerId = tool,
): Diagnostic {
	return {
		id: `${tool}:${line}`,
		message: `${tool} finding at ${line}`,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool,
		runnerId,
		rule: "error",
	};
}

function record(
	runtime: RuntimeCoordinator,
	filePath: string,
	diagnostics: Diagnostic[],
): void {
	runtime.recordInlineBlockers(
		filePath,
		formatDiagnostics(diagnostics, "blocking").trim(),
		runtime.nextWriteIndex(),
		[...new Set(diagnostics.map((d) => d.tool ?? "unknown"))],
		diagnostics
			.filter((d) => d.filePath === filePath)
			.map((d) => d.line)
			.filter((line): line is number => typeof line === "number"),
		undefined,
		diagnostics,
	);
}

describe("#5020 retireForeignRows", () => {
	it("drops the rows naming the cited file, keeps the record's own, and rebuilds the derived fields", () => {
		const env = setupTestEnvironment("pi-lens-5020-narrow-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			const b = path.join(env.tmpDir, "b.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, a, [row(a, 1, "yamllint"), row(b, 2, "helm-lint")]);

			const changed = runtime.retireForeignRows(
				"cited-file-clean",
				(r) => r.filePath === b,
				runtime.nextWriteIndex(),
			);

			expect(changed.map((c) => c.filePath)).toEqual([a]);
			const [after] = runtime.getInlineBlockersSnapshot();
			expect(after?.diagnostics?.map((d) => d.tool)).toEqual(["yamllint"]);
			// The retired row's source and line leave with it, so the next verdict
			// that covers the rest can retire the rest.
			expect(after?.sources).toEqual(["yamllint"]);
			expect(after?.lines).toEqual([1]);
			expect(after?.summary).not.toContain("helm-lint finding");
			// A narrowed record is not a resolved file.
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("never retires a row of the record's own file, whatever the verdict says", () => {
		const env = setupTestEnvironment("pi-lens-5020-own-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, a, [row(a, 1, "yamllint")]);

			expect(runtime.retireForeignRows("cited-file-clean", () => true)).toEqual(
				[],
			);
			expect(runtime.getInlineBlockersSnapshot()[0]?.diagnostics).toHaveLength(
				1,
			);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents: a record can hold a blocking row with no cited file
	// (the `Diagnostic` type requires `filePath`, so such a row reaches the record
	// only from outside the type system, and this cell builds that shape with the
	// cast below). A retire must keep it and must not dereference the absent path:
	// with `isCrossFileBlocker`'s `!!d.filePath` clause removed this cell throws
	// `TypeError: Cannot read properties of undefined (reading 'includes')`, which
	// is what a turn-end hook would do instead of delivering its findings.
	it("keeps a row that cites no file and places its line, as the record's own", () => {
		const env = setupTestEnvironment("pi-lens-5020-nocite-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			const b = path.join(env.tmpDir, "b.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			const noCite = {
				id: "helm-lint:3",
				message: "helm-lint finding at 3",
				line: 3,
				severity: "error",
				semantic: "blocking",
				tool: "helm-lint",
				runnerId: "helm-lint",
				rule: "error",
			} as unknown as Diagnostic;
			record(runtime, a, [noCite, row(b, 2, "helm-lint")]);

			const changed = runtime.retireForeignRows(
				"cited-file-clean",
				(r) => r.filePath === b,
				runtime.nextWriteIndex(),
			);

			expect(changed.map((c) => c.filePath)).toEqual([a]);
			const [after] = runtime.getInlineBlockersSnapshot();
			expect(after?.diagnostics).toEqual([noCite]);
			// Read as the record's own, so its line is placed in this file — the
			// same reading `clients/pipeline.ts` gives such a row when it stamps a
			// line hash. The derived `lines` is rebuilt from the survivors.
			expect(after?.lines).toEqual([3]);
		} finally {
			env.cleanup();
		}
	});

	it("removes a record whose rows all name the cited file, and says it was resolved", () => {
		const env = setupTestEnvironment("pi-lens-5020-all-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			const b = path.join(env.tmpDir, "b.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, a, [row(b, 2, "helm-lint")]);

			runtime.retireForeignRows(
				"cited-file-clean",
				() => true,
				runtime.nextWriteIndex(),
			);

			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			expect(runtime.hasResolvedBlockerFiles()).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a record the clean verdict is not strictly newer than", () => {
		const env = setupTestEnvironment("pi-lens-5020-order-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			const b = path.join(env.tmpDir, "b.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			const older = runtime.nextWriteIndex();
			record(runtime, a, [row(b, 2, "helm-lint")]);

			expect(
				runtime.retireForeignRows("cited-file-clean", () => true, older),
			).toEqual([]);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("leaves a record with no structured rows alone", () => {
		const env = setupTestEnvironment("pi-lens-5020-text-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			runtime.recordInlineBlockers(
				a,
				"🔴 STOP — 1 issue(s) must be fixed:",
				runtime.nextWriteIndex(),
				["helm-lint"],
			);

			expect(runtime.retireForeignRows("cited-file-clean", () => true)).toEqual(
				[],
			);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});
});

describe("#5020 retireForeignRowsOfMissingFiles", () => {
	it("retires a row whose absolute cite is gone and keeps one whose file exists", () => {
		const env = setupTestEnvironment("pi-lens-5020-missing-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			const kept = path.join(env.tmpDir, "kept.yaml");
			const gone = path.join(env.tmpDir, "gone.yaml");
			fs.writeFileSync(a, "a: 1\n");
			fs.writeFileSync(kept, "k: 1\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, a, [
				row(kept, 1, "helm-lint"),
				row(gone, 2, "helm-lint"),
			]);

			const changed = runtime.retireForeignRowsOfMissingFiles();

			expect(changed.map((c) => c.filePath)).toEqual([a]);
			const [after] = runtime.getInlineBlockersSnapshot();
			expect(after?.diagnostics?.map((d) => d.filePath)).toEqual([kept]);
			// A deletion is not a clean verdict: no "Resolved" claim.
			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
			expect(runtime.retireForeignRowsOfMissingFiles()).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents: a row spelled relatively (`a.ts` for the record
	// `/tmp/x/a.ts`) reads as another file, and resolving it against a guessed
	// root found it "missing" and retired a live blocker of the record's own file
	// (tests/clients/turn-end-resolved-blockers.test.ts went red on exactly that).
	it("keeps a row with a relative cite it cannot place", () => {
		const env = setupTestEnvironment("pi-lens-5020-relative-");
		try {
			const a = path.join(env.tmpDir, "a.yaml");
			fs.writeFileSync(a, "a: 1\n");
			const runtime = new RuntimeCoordinator();
			record(runtime, a, [row("a.yaml", 1, "helm-lint")]);

			expect(runtime.retireForeignRowsOfMissingFiles()).toEqual([]);
			expect(runtime.getInlineBlockersSnapshot()[0]?.diagnostics).toHaveLength(
				1,
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("#5020 verdictRunnerIds", () => {
	const runner = (
		runnerId: string,
		status: "succeeded" | "failed" | "skipped",
	) =>
		({
			runnerId,
			status,
			startTime: 0,
			endTime: 0,
			durationMs: 0,
			diagnosticCount: 0,
			semantic: "none",
		}) as const;

	it("names the runners that succeeded and were not inconclusive", () => {
		expect(
			verdictRunnerIds({
				latencyReport: {
					runners: [
						runner("helm-lint", "succeeded"),
						runner("mypy", "failed"),
						runner("ruff-lint", "skipped"),
						runner("yamllint", "succeeded"),
					],
				} as never,
				inconclusiveSources: {
					runnerIds: ["yamllint"],
					serverIds: [],
					collectLaterRunnerIds: [],
				},
			}),
		).toEqual(["helm-lint"]);
	});

	// Recurrence it prevents: `checkedWholeFile` in the same module refuses an
	// edit-scoped verdict, and this predicate admitted one, so an ast-grep run
	// that answered only for the edited ranges could retire another file's row
	// on evidence that never covered the rest of the file (PR #5033 review F3).
	it("refuses a runner whose verdict covers only the edited ranges", () => {
		expect(
			verdictRunnerIds({
				latencyReport: {
					runners: [
						runner("ast-grep", "succeeded"),
						runner("helm-lint", "succeeded"),
					],
				} as never,
				editScopedRunnerIds: ["ast-grep"],
				inconclusiveSources: {
					runnerIds: [],
					serverIds: [],
					collectLaterRunnerIds: [],
				},
			}),
		).toEqual(["helm-lint"]);
	});
});
