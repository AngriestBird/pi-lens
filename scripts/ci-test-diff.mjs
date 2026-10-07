#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
	extractVitestFailureIds,
	OVERALL_TESTS_FAILED,
	stripAnsi,
	stripLineTimestamps,
} from "./lib/ci-failure-classifier.mjs";

const DEFAULT_REPOSITORY = "apmantza/pi-lens";
export function stripLogDecorations(log) {
	const withoutFallbackPrefix = log.replace(
		/^[^\t\r\n]+\t[^\t\r\n]+\t(?=\d{4}-\d\d-\d\dT)/gm,
		"",
	);
	return stripLineTimestamps(stripAnsi(withoutFallbackPrefix))
		.replace(/^\uFEFF/, "")
		.replace(/^[ \t]+(?=FAIL\b)/gm, "")
		.replace(/\r\n?/g, "\n");
}

export function extractFailingTestIds(log) {
	return extractVitestFailureIds(log);
}

export function summarizeLog(log, side = "job") {
	const failedMatch = OVERALL_TESTS_FAILED.exec(log);
	const passedMatch = log.match(/^\s*Tests\s+(\d+)\s+passed\b/m);
	const testsFailed = Number(failedMatch?.[1] ?? 0);
	const failedTestsHeader = Number(
		log.match(/\bFailed Tests\s+(\d+)\b/i)?.[1] ?? NaN,
	);
	const suitesFailed = Number(
		log.match(/\bFailed Suites\s+(\d+)\b/i)?.[1] ?? 0,
	);
	const unhandledErrors = Number(
		log.match(/\bErrors\s+(\d+)\s+error(?:s)?\b/i)?.[1] ?? 0,
	);
	if (!failedMatch && !passedMatch) {
		throw new Error(`${side} log incomplete (no Vitest Tests summary)`);
	}
	if (
		Number.isInteger(failedTestsHeader) &&
		failedTestsHeader !== testsFailed
	) {
		throw new Error(`${side} log has mismatched Vitest failure summaries`);
	}
	return { testsFailed, suitesFailed, unhandledErrors };
}

export function validateLog(log, side = "job") {
	const summary = summarizeLog(log, side);
	const ids = extractFailingTestIds(log);
	const expected = summary.testsFailed + summary.suitesFailed;
	if (ids.length !== expected) {
		throw new Error(
			`${side} log has ${ids.length} failure IDs; Vitest summary reports ${expected}`,
		);
	}
	return { ids, ...summary };
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
	const previousReport = validateLog(
		stripLogDecorations(fetchJobLog(repository, jobA)),
		`job ${jobA}`,
	);
	const currentReport = validateLog(
		stripLogDecorations(fetchJobLog(repository, jobB)),
		`job ${jobB}`,
	);
	const previous = previousReport.ids;
	const current = currentReport.ids;
	const diff = compareFailureSets(previous, current);
	console.log(
		`Input: ${jobA} tests=${previousReport.testsFailed} suites=${previousReport.suitesFailed} errors=${previousReport.unhandledErrors}; ${jobB} tests=${currentReport.testsFailed} suites=${currentReport.suitesFailed} errors=${currentReport.unhandledErrors}`,
	);
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
