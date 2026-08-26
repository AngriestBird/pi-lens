#!/usr/bin/env node
// CI failure classifier CLI (#2103). Reads one failed workflow run's Unit
// tests job log, decides infra-oom / infra-net / real, posts (or updates) one
// sticky PR comment, and reruns the failed jobs ONCE per head SHA when the
// classification is infra. See scripts/lib/ci-failure-classifier.mjs for the
// decision logic.
//
// A human or an orchestrator runs this by hand today, on a run id it already
// knows is red:
//
//   GITHUB_TOKEN=... node scripts/classify-ci-failure.mjs --run 32908647308
//
// It is deliberately NOT wired to a workflow_run trigger yet (refs #2103,
// see the PR body): that needs a decision about `actions: write` scope and a
// real workflow_run payload to test the PR-resolution path against, which
// this PR does not have on hand.

import { runClassifier } from "./lib/ci-failure-classifier.mjs";

function parseArgs(argv) {
	const args = { runId: null, jobName: "Unit tests", prNumber: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--run") args.runId = argv[++i];
		else if (arg === "--job-name") args.jobName = argv[++i];
		else if (arg === "--pr") args.prNumber = Number(argv[++i]);
	}
	return args;
}

async function main() {
	const { runId, jobName, prNumber } = parseArgs(process.argv.slice(2));
	if (!runId) {
		console.error(
			"usage: node scripts/classify-ci-failure.mjs --run <runId> [--job-name <name>] [--pr <number>]",
		);
		process.exitCode = 2;
		return;
	}

	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (!repository || !token) {
		throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN/GH_TOKEN are required");
	}
	const [owner, repo] = repository.split("/");

	const fetcher = (url, init) =>
		fetch(url, {
			...init,
			headers: { ...init?.headers, authorization: `Bearer ${token}` },
		});

	const result = await runClassifier({
		fetcher,
		owner,
		repo,
		runId,
		jobName,
		prNumber: prNumber || undefined,
	});

	console.log(
		`PR #${result.prNumber} sha=${result.sha} job=${result.jobName} -> ` +
			`${result.classification.kind}${result.rerunTriggered ? " (rerun triggered)" : ""}`,
	);
	console.log(result.commentBody);
}

main().catch((error) => {
	console.error(
		`ci failure classifier failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
