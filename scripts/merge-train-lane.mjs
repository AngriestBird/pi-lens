#!/usr/bin/env node
// CI entry point for the label-gated merge lane (#2185). See
// scripts/lib/merge-train-lane.mjs for the gate and
// .github/workflows/merge-train-lane.yml for the triggers and permissions.

import { appendFileSync } from "node:fs";
import { runMergeLane } from "./lib/merge-train-lane.mjs";

async function main() {
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (!repository || !token)
		throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN/GH_TOKEN are required");
	const [owner, repo] = repository.split("/");

	const fetcher = (url, init) =>
		fetch(url, {
			...init,
			headers: { ...init?.headers, authorization: `Bearer ${token}` },
		});

	const results = await runMergeLane({ fetcher, owner, repo });

	const lines = [
		`Merge train: evaluated ${results.length} approved PR record(s).`,
	];
	for (const r of results) {
		lines.push(
			`- ${r.number === null ? "(list fetch)" : `#${r.number} ${r.url}`}: ${r.merged ? `MERGED (${r.method})` : `holding — ${r.reason}`}`,
		);
		if (r.detail) lines.push(`  ${r.detail}`);
		if (r.runHealth) lines.push(`  runs: ${r.runHealth}`);
		if (r.errors.length > 0)
			lines.push(
				`  ${r.errors.map((e) => `${e.benign ? "note" : "ERROR"}: ${e.message}`).join("; ")}`,
			);
	}
	if (lines.length === 1)
		lines.push("No PR carries the train:approved label this run.");
	const summary = lines.join("\n");
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

	// Same benign/fatal split as the warden: a 409 from a head that moved
	// mid-cycle is the guard working, not a lane failure.
	if (results.some((r) => r.errors.some((e) => !e.benign))) process.exitCode = 1;
}

main().catch((error) => {
	console.error(
		`Merge train failed to run: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
