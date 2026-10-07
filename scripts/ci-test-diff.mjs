#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_REPOSITORY = "apmantza/pi-lens";
// oxlint-disable-next-line no-control-regex -- ANSI is the input being removed.
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ACTIONS_TIMESTAMP = /^\d{4}-\d\d-\d\dT[^ ]+Z\s*/;
const TEST_PATH = String.raw`(tests/[^\s]+?\.test\.[cm]?[jt]sx?)`;

export function stripLogDecorations(log) {
	return log
		.replace(/^\uFEFF/, "")
		.replace(ANSI_ESCAPE, "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(ACTIONS_TIMESTAMP, ""))
		.join("\n");
}

export function extractFailingTestIds(log) {
	const lines = log.split("\n");
	const ids = new Set();
	const failurePattern = new RegExp(
		String.raw`^\s*FAIL\s+\S+\s+${TEST_PATH}(?:\s+>\s+(.+?))?\s*$`,
	);
	for (const line of lines) {
		const match = line.match(failurePattern);
		if (match) {
			const details = match[2] ? ` › ${match[2].replace(/\s+/g, " ")}` : "";
			ids.add(`${match[1]}${details}`);
		}
	}
	return [...ids].sort();
}

export function compareFailureSets(previous, current) {
	const oldSet = new Set(previous);
	const newSet = new Set(current);
	return {
		fixed: [...oldSet].filter((id) => !newSet.has(id)).sort(),
		newFailures: [...newSet].filter((id) => !oldSet.has(id)).sort(),
		unchanged: [...oldSet].filter((id) => newSet.has(id)).sort(),
	};
}

function fetchJobLog(repository, jobId) {
	try {
		return execFileSync(
			"gh",
			[
				"api",
				`repos/${repository}/actions/jobs/${jobId}/logs`,
				"--allow-escape-sequences",
			],
			{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
		);
	} catch (error) {
		try {
			return execFileSync(
				"gh",
				["run", "view", "--job", jobId, "--log", "--repo", repository],
				{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
			);
		} catch (fallbackError) {
			const message =
				fallbackError instanceof Error
					? fallbackError.message
					: String(fallbackError);
			throw new Error(`could not fetch logs for job ${jobId}: ${message}`, {
				cause: error,
			});
		}
	}
}

function printSet(label, values) {
	console.log(`${label} (${values.length})`);
	for (const value of values) console.log(`  ${value}`);
}

export function parseArgs(argv) {
	if (argv.length < 2 || argv.length > 4) {
		throw new Error(
			"usage: ci-test-diff.mjs <jobA> <jobB> [--repo owner/name]",
		);
	}
	const [jobA, jobB, option, repository] = argv;
	if (!/^\d+$/.test(jobA) || !/^\d+$/.test(jobB)) {
		throw new Error("job IDs must be numeric");
	}
	if (option && option !== "--repo") {
		throw new Error(
			"usage: ci-test-diff.mjs <jobA> <jobB> [--repo owner/name]",
		);
	}
	if (option && (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository))) {
		throw new Error("--repo requires owner/name");
	}
	return { jobA, jobB, repository: repository ?? DEFAULT_REPOSITORY };
}

export function main(argv = process.argv.slice(2)) {
	const { jobA, jobB, repository } = parseArgs(argv);
	const previous = extractFailingTestIds(
		stripLogDecorations(fetchJobLog(repository, jobA)),
	);
	const current = extractFailingTestIds(
		stripLogDecorations(fetchJobLog(repository, jobB)),
	);
	const diff = compareFailureSets(previous, current);
	printSet("FIXED", diff.fixed);
	printSet("NEW", diff.newFailures);
	printSet("UNCHANGED", diff.unchanged);
	console.log(
		`Summary: fixed=${diff.fixed.length} new=${diff.newFailures.length} unchanged=${diff.unchanged.length}`,
	);
	return diff.newFailures.length ? 1 : 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		process.exitCode = main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
