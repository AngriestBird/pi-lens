// #3801: ci.yml starts the heavy advisory jobs (mutation, the Windows Vitest
// subset) only after every required check passed, so until then GitHub has no
// check-run for them. ci-verdict lists each as PENDING while the verdict is
// pending, and never lets one move an exit code.
//
// Recurrences this file guards:
//  - a deferred job reading as "absent" (indistinguishable from a lane that
//    was deleted) while the required checks are still running;
//  - a deferred advisory row gating: pending it must not hold a verdict that
//    is otherwise success, and absent it must not fail one;
//  - an older head (no heavy-gate in its workflow) being relabelled PENDING
//    forever once its verdict is terminal.
import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	formatGatingSplit,
	formatMutationLine,
	formatVerdictTable,
} from "../../scripts/ci-verdict.mjs";
import {
	DEFERRED_ADVISORY_CHECKS,
	isAdvisoryCheck,
} from "../../scripts/lib/ci-checks.mjs";

function checkRun(
	name: string,
	status = "completed",
	conclusion: string | null = "success",
	id = 1,
) {
	return {
		name,
		status,
		conclusion,
		started_at: "2026-09-30T00:00:00Z",
		id,
		html_url: `https://github.com/apmantza/pi-lens/actions/runs/${id}`,
		details_url: `https://github.com/apmantza/pi-lens/actions/runs/${id}/job/${id}`,
	};
}

const deferred = (rows: Array<{ name: string; deferred?: boolean }>) =>
	rows.filter((row) => row.deferred).map((row) => row.name);

describe("ci-verdict deferred advisory rows (#3801)", () => {
	it("names every deferred heavy job PENDING while a required check is still running", () => {
		const verdict = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "success", 1),
				checkRun("Lint & type-check", "in_progress", null, 2),
			],
		});
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(deferred(verdict.rows)).toEqual([...DEFERRED_ADVISORY_CHECKS]);
		const table = formatVerdictTable(verdict.rows);
		// Columns are CHECK / STATUS / CONCLUSION / URL, separated by 2+ spaces.
		const columns = table
			.split("\n")
			.map((line) => line.split(/\s{2,}/).slice(0, 3));
		for (const name of DEFERRED_ADVISORY_CHECKS) {
			expect(columns).toContainEqual([name, "PENDING", "-"]);
		}
	});

	it("keeps them advisory: rows never gate, and a success with every heavy job absent stays success", () => {
		const base = [
			checkRun("Unit tests", "completed", "success", 1),
			checkRun("Lint & type-check", "completed", "success", 2),
		];
		const success = computeVerdict({ check_runs: base });
		expect(success.exitCode).toBe(EXIT_SUCCESS);
		expect(deferred(success.rows)).toEqual([]);

		const pending = computeVerdict({
			check_runs: [base[0], checkRun("Lint & type-check", "queued", null, 2)],
		});
		const gating = pending.rows.filter(
			(row: { gating: boolean }) => row.gating,
		);
		expect(gating.map((row: { name: string }) => row.name)).toEqual([
			"Unit tests",
			"Lint & type-check",
		]);
		for (const name of DEFERRED_ADVISORY_CHECKS)
			expect(isAdvisoryCheck(name)).toBe(true);
		// The split counts them on the advisory side only.
		expect(formatGatingSplit(pending.rows, pending.failingRows)[0]).toBe(
			"Gating: 2 checks, 0 failing",
		);
	});

	it("does not relabel a terminal verdict: a failed head lists no deferred rows", () => {
		const failed = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "failure", 1),
				checkRun("Lint & type-check", "completed", "success", 2),
			],
		});
		expect(failed.exitCode).toBe(EXIT_FAILURE);
		expect(deferred(failed.rows)).toEqual([]);
	});

	it("does not duplicate a deferred job that already has a check-run", () => {
		const verdict = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "success", 1),
				checkRun("Lint & type-check", "in_progress", null, 2),
				checkRun("mutation (advisory)", "in_progress", null, 3),
			],
		});
		expect(
			verdict.rows.filter(
				(row: { name: string }) => row.name === "mutation (advisory)",
			),
		).toHaveLength(1);
		expect(deferred(verdict.rows)).toEqual(["Unit tests Windows (advisory)"]);
	});

	// Recurrence: the MUTATION line read a deferred job as "not running" and
	// printed STALE for the previous head's comment while the new head's job was
	// only waiting on the required checks.
	it("makes the MUTATION line say PENDING, not STALE, for a deferred job", () => {
		const verdict = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "success", 1),
				checkRun("Lint & type-check", "in_progress", null, 2),
			],
		});
		const head = "b".repeat(40);
		expect(formatMutationLine([], head, verdict.rows)).toMatch(
			/PENDING -- no Mutation diff comment on this PR yet$/,
		);
		const previousHead = "a".repeat(40);
		const comment = {
			id: 9,
			user: { login: "github-actions[bot]" },
			body: `<!-- pi-lens-mutation-diff -->\n### Mutation diff (advisory)\n\n- **Head:** \`${previousHead}\`\n\nNo survivors.`,
		};
		const line = formatMutationLine([comment], head, verdict.rows);
		expect(line).toContain(
			"PENDING -- the mutation job is waiting for the required checks on PR head",
		);
	});
});
