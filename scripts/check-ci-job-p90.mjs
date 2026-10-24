#!/usr/bin/env node
/**
 * scripts/check-ci-job-p90.mjs (#4691, item 3 of #3920): the nightly warning
 * that a required CI job's p90 runtime over recent master runs nears its
 * `timeout-minutes` cap. Wired as a step in .github/workflows/untriaged-issues.yml.
 *
 * This CLI is the host boundary: it reads ci.yml, lists the last N completed
 * master push runs of ci.yml with `gh api`, and reads each run's job rows.
 * The computation is scripts/lib/ci-job-p90.mjs and is what the tests drive.
 *
 * It warns and never gates: exit 0 whenever the data was read, one
 * `::warning` annotation per job (never one per shard sample). Exit 1 only
 * when the data could not be read, so a broken nightly is visible.
 *
 * Usage: node scripts/check-ci-job-p90.mjs [--runs N] [--workflow path]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { load } from "js-yaml";
import {
	formatP90Warning,
	p90Warnings,
	P90_CAP_RATIO,
	requiredJobSpecs,
} from "./lib/ci-job-p90.mjs";

const DEFAULT_RUNS = 20;
const MAX_RUNS = 100;

function gh(args) {
	const result = spawnSync("gh", args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			`gh ${args.join(" ")} failed (exit ${result.status}): ${result.stderr?.trim()}`,
		);
	}
	return result.stdout;
}

/** Workflow commands escape %, CR and LF in the message body. */
function annotationData(text) {
	return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function parseArgs(argv) {
	let runs = DEFAULT_RUNS;
	let workflow = ".github/workflows/ci.yml";
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--runs") runs = Number(argv[(i += 1)]);
		else if (argv[i] === "--workflow") workflow = argv[(i += 1)];
		else throw new Error(`unknown argument: ${argv[i]}`);
	}
	if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
		throw new Error(`--runs must be an integer 1..${MAX_RUNS}`);
	}
	return { runs, workflow };
}

function listMasterRuns(count) {
	const body = JSON.parse(
		gh([
			"api",
			`repos/{owner}/{repo}/actions/workflows/ci.yml/runs?branch=master&event=push&status=completed&per_page=${count}`,
		]),
	);
	return body.workflow_runs ?? [];
}

function jobRowsOf(runId) {
	const lines = gh([
		"api",
		"--paginate",
		`repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`,
		"--jq",
		".jobs[]",
	]);
	return lines
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

async function main() {
	const { runs: runCount, workflow } = parseArgs(process.argv.slice(2));
	const ci = load(readFileSync(workflow, "utf8"));
	const specs = requiredJobSpecs(ci);
	const runs = listMasterRuns(runCount).map((run) => ({
		id: run.id,
		created_at: run.created_at,
		jobs: jobRowsOf(run.id),
	}));
	const { warnings, skipped } = p90Warnings({ specs, runs });
	for (const w of warnings) {
		console.log(
			`::warning title=CI job p90 near timeout::${annotationData(formatP90Warning(w))}`,
		);
	}
	const skippedText = skipped.map((s) => `${s.key} (${s.reason})`).join(", ");
	console.log(
		`ci-job-p90: ${specs.length} required jobs over ${runs.length} master runs ` +
			`at ratio ${P90_CAP_RATIO}; ${warnings.length} warning(s)` +
			(skippedText ? `; skipped: ${skippedText}` : ""),
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		console.error(
			`check-ci-job-p90: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	});
}
