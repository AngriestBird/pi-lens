// #1712: the committed first measured table (the #1549 budget input) is the
// lane's own artifact, so it has to keep describing the lane that produced it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CASCADE_CONCLUSIVE_DEADLINE_MS,
	CASCADE_FIXTURES,
	cascadeTimesRecord,
} from "../../scripts/lib/lsp-cascade-smoke.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const table = JSON.parse(
	readFileSync(
		resolve(REPO_ROOT, "tests/fixtures/lsp-cascade/measurements.json"),
		"utf8",
	),
) as {
	schema: number;
	command: string;
	date: string;
	runner: { ci: boolean; runId: string | null } & Record<string, unknown>;
	rows: {
		lang: string;
		state: string;
		timeToConclusiveMs: number | null;
	}[];
};

describe("tests/fixtures/lsp-cascade/measurements.json (#1712)", () => {
	it("is a record of the schema the lane writes, taken on a CI runner", () => {
		// Recurrence: a table typed by hand, or taken on a laptop, would set the
		// #1549 budget from a machine the nightly never runs on.
		const written = cascadeTimesRecord([], {}, {});
		expect(table.schema).toBe(written.schema);
		expect(table.command).toBe(written.command);
		expect(Object.keys(table.runner).sort()).toEqual(
			Object.keys(written.runner).sort(),
		);
		expect(table.runner.ci).toBe(true);
		expect(table.runner.runId).toMatch(/^\d+$/);
		expect(table.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("has one row per fixture, concluded exactly where no inconclusive is declared", () => {
		// Recurrence: a fixture added without a measurement, or a declared
		// inconclusive server carrying a time-to-conclusive it never had.
		expect(table.rows.map((r) => r.lang)).toEqual(
			CASCADE_FIXTURES.map((f) => f.lang),
		);
		for (const fixture of CASCADE_FIXTURES) {
			const row = table.rows.find((r) => r.lang === fixture.lang);
			expect(row?.state).toBe("pass");
			expect(row?.timeToConclusiveMs === null).toBe(
				"expectInconclusive" in fixture,
			);
		}
	});

	it("leaves every conclusive deadline at least ten times the measured time", () => {
		// Recurrence: #1549, a budget set on the edge of a measurement reds the
		// nightly on runner noise.
		for (const row of table.rows) {
			if (row.timeToConclusiveMs === null) continue;
			const fixture = CASCADE_FIXTURES.find((f) => f.lang === row.lang);
			const deadline =
				fixture?.conclusiveDeadlineMs ?? CASCADE_CONCLUSIVE_DEADLINE_MS;
			expect(deadline).toBeGreaterThanOrEqual(10 * row.timeToConclusiveMs);
		}
	});
});
