#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export const MAX_ATTEMPTS = 4;
const DEFAULT_NAMES = [
	"unit-test-results-linux",
	"unit-test-results-linux-shard-1",
	"unit-test-results-linux-shard-2",
	"unit-test-results-linux-shard-3",
	"unit-test-results-linux-shard-4",
	"unit-test-results-linux-shard-5",
];

function options(argv) {
	const result = {
		repository: process.env.GITHUB_REPOSITORY,
		outputDir: null,
		names: [],
	};
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--repository") result.repository = argv[++i];
		else if (argv[i] === "--output-dir") result.outputDir = argv[++i];
		else if (argv[i] === "--artifact-name") result.names.push(argv[++i]);
		else throw new Error(`unknown option ${argv[i]}`);
	}
	if (!result.repository || !result.outputDir)
		throw new Error("--repository and --output-dir are required");
	if (!result.names.length) result.names = DEFAULT_NAMES;
	return result;
}

function pause(attempt) {
	const delay =
		Number(process.env.TEST_HISTORY_RETRY_DELAY_MS ?? 1000) *
		2 ** (attempt - 1);
	if (delay > 0)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function isRetryable(result) {
	return /\bHTTP 5\d\d\b/.test(`${result.stderr}\n${result.stdout}`);
}

function runGh(args, encoding = "utf8") {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		const result = spawnSync("gh", ["api", ...args], { encoding });
		if (result.status === 0) return result.stdout;
		if (!isRetryable(result) || attempt === MAX_ATTEMPTS) {
			throw new Error(
				String(result.stderr || result.stdout || `gh exited ${result.status}`),
			);
		}
		pause(attempt);
	}
	throw new Error("unreachable");
}

function newestArtifactIds(repository, name) {
	const output = runGh([
		"--paginate",
		`/repos/${repository}/actions/artifacts?name=${name}&per_page=100`,
		"--jq",
		".artifacts[] | select(.expired == false) | {id,created_at}",
	]);
	const artifacts = String(output)
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
	return artifacts[0]?.id;
}

export function downloadArtifacts({
	repository,
	outputDir,
	names = DEFAULT_NAMES,
}) {
	fs.mkdirSync(outputDir, { recursive: true });
	for (const name of names) {
		const artifactId = newestArtifactIds(repository, name);
		if (artifactId === undefined) continue;
		const zip = runGh(
			[`/repos/${repository}/actions/artifacts/${artifactId}/zip`],
			"buffer",
		);
		fs.writeFileSync(path.join(outputDir, `${artifactId}.zip`), zip);
	}
}

try {
	downloadArtifacts(options(process.argv.slice(2)));
} catch (error) {
	console.error(error instanceof Error ? error.message.trim() : String(error));
	process.exitCode = 1;
}
