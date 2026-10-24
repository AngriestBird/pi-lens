#!/usr/bin/env node
// A `gh` stand-in for tests/scripts/check-ci-job-p90.test.ts (#4691). It is a
// process boundary, not a mock of the check: it serves the recorded master runs
// in FAKE_GH_FIXTURE in the two shapes scripts/check-ci-job-p90.mjs reads.
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, "utf8"));
const args = process.argv.slice(2).join(" ");

if (fixture.failRead) {
	console.error("HTTP 500: recorded failure");
	process.exit(1);
}
if (args.includes("/actions/workflows/ci.yml/runs")) {
	const count = Number(/per_page=(\d+)/.exec(args)?.[1] ?? 20);
	const workflow_runs = fixture.runs
		.slice(0, count)
		.map((run) => ({ id: run.id, created_at: run.created_at }));
	console.log(JSON.stringify({ workflow_runs }));
	process.exit(0);
}
const jobs = /actions\/runs\/(\d+)\/jobs/.exec(args);
if (jobs) {
	const run = fixture.runs.find((r) => String(r.id) === jobs[1]);
	for (const job of run?.jobs ?? []) console.log(JSON.stringify(job));
	process.exit(0);
}
console.error(`fake gh: unrecorded call: ${args}`);
process.exit(2);
