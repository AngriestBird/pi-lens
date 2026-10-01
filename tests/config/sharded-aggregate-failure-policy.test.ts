import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

type Job = {
	"continue-on-error"?: boolean | string;
	steps?: { name?: string; "continue-on-error"?: boolean | string }[];
};

const jobs = (
	yaml.load(
		readFileSync(
			resolve(import.meta.dirname, "../../.github/workflows/ci.yml"),
			"utf8",
		),
	) as { jobs: Record<string, Job> }
).jobs;

describe("#3920 sharded required-check failure policy", () => {
	// Recurrence: the #3919 review demonstrated that continue-on-error on a
	// shard job or aggregate step turns a failed required check green while
	// the existing aggregate-governance tests still pass. Parse YAML so prose
	// cannot satisfy this guard; expressions cannot override the failure policy.
	it.each([
		["test", "unit-tests"],
		["tla-shards", "tla-models"],
	])("keeps %s failures required through %s", (shardId, aggregateId) => {
		for (const id of [shardId, aggregateId]) {
			const job = jobs[id];
			expect(job, `${id} must exist`).toBeDefined();
			expect(
				job["continue-on-error"] ?? false,
				`${id} must not tolerate failure`,
			).toBe(false);
		}
		const steps = jobs[aggregateId].steps ?? [];
		expect(
			steps.length,
			`${aggregateId} must enforce its result`,
		).toBeGreaterThan(0);
		for (const step of steps) {
			expect(
				step["continue-on-error"] ?? false,
				`${aggregateId}: ${step.name} must not tolerate failure`,
			).toBe(false);
		}
	});
});
