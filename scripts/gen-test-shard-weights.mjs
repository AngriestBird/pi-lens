#!/usr/bin/env node
/**
 * scripts/gen-test-shard-weights.mjs (#3771, #3801)
 *
 *   node scripts/gen-test-shard-weights.mjs --run <dir> [--run <dir> ...] [--out <file>]
 *
 * Regenerates scripts/test-shard-weights.json, the per-file seconds the
 * duration-balanced shard assignment (scripts/lib/test-shard-assignment.mjs)
 * packs by. Each `--run` is a directory holding the `vitest-results.json`
 * files of ONE CI run (download them with
 * `gh run download <run-id> -p 'unit-test-results-linux-shard-*' -D <dir>`;
 * the shards' artifacts are the same JSON the nightly test-history rollup
 * reads). A file's weight is the median of its per-run durations, so one slow
 * runner does not skew it. Keys are repo-relative posix paths and the output
 * is sorted, so regenerating from the same runs is byte-identical.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { median } from "./lib/test-shard-assignment.mjs";

/** @param {string} dir @returns {string[]} */
function resultFilesUnder(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...resultFilesUnder(full));
		else if (entry.name === "vitest-results.json") found.push(full);
	}
	return found;
}

/**
 * Repo-relative posix id of a vitest JSON `name`: everything from the first
 * `/tests/` on (every test file lives under tests/; the prefix is the CI
 * checkout or a local worktree).
 *
 * @param {string} name
 * @returns {string|null}
 */
export function testFileId(name) {
	const posix = String(name).replaceAll("\\", "/");
	const at = posix.indexOf("/tests/");
	return at === -1 ? null : posix.slice(at + 1);
}

/**
 * @param {string[][]} runs per run, the JSON report paths of its shards
 * @returns {Record<string, number>}
 */
export function buildWeights(runs) {
	/** @type {Map<string, number[]>} */
	const samples = new Map();
	for (const reports of runs) {
		/** @type {Map<string, number>} */
		const thisRun = new Map();
		for (const report of reports) {
			const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
			for (const result of parsed.testResults ?? []) {
				const id = testFileId(result.name);
				if (id === null) continue;
				const seconds = (result.endTime - result.startTime) / 1000;
				if (Number.isFinite(seconds) && seconds >= 0) thisRun.set(id, seconds);
			}
		}
		for (const [id, seconds] of thisRun) {
			const list = samples.get(id) ?? [];
			list.push(seconds);
			samples.set(id, list);
		}
	}
	const files = {};
	for (const id of [...samples.keys()].sort()) {
		files[id] = Math.round(median(samples.get(id)) * 100) / 100;
	}
	return files;
}

function main(argv) {
	const runDirs = [];
	let out = "scripts/test-shard-weights.json";
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--run") runDirs.push(argv[++i]);
		else if (argv[i] === "--out") out = argv[++i];
		else throw new Error(`unknown argument ${argv[i]}`);
	}
	if (runDirs.length === 0)
		throw new Error("at least one --run <dir> is required");
	const runs = runDirs.map((dir) => {
		const reports = resultFilesUnder(dir);
		if (reports.length === 0)
			throw new Error(`no vitest-results.json under ${dir}`);
		return reports;
	});
	const files = buildWeights(runs);
	const body = {
		generatedBy: "node scripts/gen-test-shard-weights.mjs",
		runs: runDirs.length,
		files,
	};
	fs.writeFileSync(out, `${JSON.stringify(body, null, "\t")}\n`);
	console.log(
		`${out}: ${Object.keys(files).length} files from ${runDirs.length} runs`,
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main(process.argv.slice(2));
