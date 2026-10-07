#!/usr/bin/env node
/**
 * Nightly verdict on the project-snapshot persist bench (#3916, recurrence of
 * #3789): did the worker persist's RSS jump drift back toward the cloned shape?
 *
 *   node scripts/bench-snapshot-persist.mjs --persists 5 --out <report.json>
 *   node scripts/check-snapshot-persist-ratio.mjs --report <report.json> \
 *     [--body <drift.md>] [--state <file>] [--run-url <url>]
 *
 * The statistic is the first persist's RSS jump in worker mode divided by the
 * same persist in sync mode, both from ONE bench run on ONE runner, so the
 * runner's allocator and heap limits mostly cancel. Persist 0 is used, not a
 * steady-state max or median: after the first persist the settled-RSS
 * baseline moves with GC timing. The cloning worker's steady runs fell from
 * about 285 MB to about 155 MB mid-run (a median can land on either side),
 * and the fixed worker spiked once to 146-149 MB in 2 of 8 healthy runs (a
 * max can land on the wrong side), so both steady statistics flip on noise.
 * Persist 0 separated the trees in every measured run: 1.688-1.831 on the
 * fixed tree (11 runs), 2.099-2.369 on the cloning tree (9 runs); see
 * tests/fixtures/snapshot-persist-nightly-calibration.json and
 * tests/fixtures/snapshot-persist-measurement.json, pinned by
 * tests/scripts/check-snapshot-persist-ratio.test.ts. Known limit: the
 * control is the same tree's own sync path, which the cloning tree also made
 * heavier (about 150-166 MB against 92-101 MB), so the ratio understates the
 * worker's own regression; that is why the gap is only 1.83 to 2.10.
 *
 * Exit 0 clean, 1 drift (the ratio exceeds the threshold), 2 the report is
 * unusable (never a drift verdict: the workflow leaves the tracking issue as
 * it is). `--state` receives `clean`, `drift` or `error`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Drift threshold on `firstPersistRatio`: the geometric midpoint (1.96) of the
 * gap between the worst healthy run (1.831) and the best cloning-tree run
 * (2.099), rounded down. The margins are +6.5% above the worst healthy run and
 * -7.1% below the best regressed one (the committed artifacts' own
 * before/after rounds already differ by about 6% between box states, so a
 * wider claim is not measured). The first nightly's logged ratio on a hosted
 * runner is the calibration this local measurement cannot give.
 */
export const DRIFT_THRESHOLD = 1.95;

/**
 * @param {unknown} report one `bench-snapshot-persist.mjs` JSON report
 * @returns {{workerMB: number, syncMB: number, ratio: number}}
 */
export function firstPersistRatio(report) {
	const results = Array.isArray(report?.results) ? report.results : [];
	const jump = (mode) => {
		const run = results
			.find((result) => result?.mode === mode)
			?.runs?.find((candidate) => candidate?.persist === 0);
		const value = run?.rssJumpMB;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new Error(`report has no usable persist 0 rssJumpMB for ${mode}`);
		}
		return value;
	};
	const workerMB = jump("worker");
	const syncMB = jump("sync");
	return { workerMB, syncMB, ratio: workerMB / syncMB };
}

/**
 * @param {unknown} report
 * @param {{threshold?: number}} [options]
 * @returns {{state: "clean" | "drift" | "error", ratio?: number, workerMB?: number, syncMB?: number, threshold: number, reason?: string}}
 */
export function evaluate(report, { threshold = DRIFT_THRESHOLD } = {}) {
	try {
		const measured = firstPersistRatio(report);
		return {
			state: measured.ratio > threshold ? "drift" : "clean",
			...measured,
			threshold,
		};
	} catch (error) {
		return {
			state: "error",
			threshold,
			reason: error?.message ?? String(error),
		};
	}
}

/** Markdown body for the single persistent tracking issue. */
export function buildDriftBody(verdict, { runUrl, report } = {}) {
	const lines = [
		"Auto-filed/updated by the nightly `tool-smoke` workflow's `snapshot-persist-bench` job (#3916, recurrence of #3789).",
		"",
		`The worker persist's first-persist RSS jump is **${verdict.workerMB} MB** against **${verdict.syncMB} MB** on the synchronous (never-cloning) path: ratio **${verdict.ratio.toFixed(3)}**, over the committed threshold **${verdict.threshold}** (\`DRIFT_THRESHOLD\` in \`scripts/check-snapshot-persist-ratio.mjs\`). A healthy tree measured 1.69-1.83 and the tree that structured-cloned the snapshot into the worker (4.3.0) measured 2.10-2.37.`,
		"",
		"A likely cause is a change that puts a clone or a second serialization back on the worker persist path (`clients/project-snapshot.ts`, `clients/gzip-stage-write.ts`). Reproduce with `npm run build && node scripts/bench-snapshot-persist.mjs --persists 5`.",
	];
	if (report?.node || report?.platform) {
		lines.push(
			"",
			`Runner: ${report.node ?? "?"} on ${report.platform ?? "?"}`,
		);
	}
	if (runUrl) lines.push("", `Workflow run: ${runUrl}`);
	lines.push(
		"",
		"This issue is closed automatically once a nightly run is back under the threshold.",
	);
	return lines.join("\n");
}

function flag(argv, name) {
	const at = argv.indexOf(name);
	if (at < 0) return undefined;
	const value = argv[at + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${name} requires a value`);
	return value;
}

/** @returns {number} the process exit code */
export function main(argv = process.argv.slice(2), log = console.log) {
	const reportPath = flag(argv, "--report");
	if (!reportPath) throw new Error("--report is required");
	const bodyPath = flag(argv, "--body");
	const statePath = flag(argv, "--state");
	const runUrl = flag(argv, "--run-url");
	let report;
	let verdict;
	try {
		report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
		verdict = evaluate(report);
	} catch (error) {
		verdict = {
			state: "error",
			threshold: DRIFT_THRESHOLD,
			reason: `cannot read ${reportPath}: ${error?.message ?? error}`,
		};
	}
	if (statePath) {
		fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
		fs.writeFileSync(statePath, `${verdict.state}\n`);
	}
	if (bodyPath) {
		if (verdict.state === "drift") {
			fs.writeFileSync(
				bodyPath,
				`${buildDriftBody(verdict, { runUrl, report })}\n`,
			);
		} else {
			fs.rmSync(bodyPath, { force: true });
		}
	}
	if (verdict.state === "error") {
		log(`snapshot-persist ratio: error: ${verdict.reason}`);
		return 2;
	}
	log(
		`snapshot-persist ratio: ${verdict.state} worker=${verdict.workerMB}MB sync=${verdict.syncMB}MB ratio=${verdict.ratio.toFixed(3)} threshold=${verdict.threshold}`,
	);
	if (verdict.state === "drift") {
		log(
			`::error::snapshot persist worker/sync RSS ratio ${verdict.ratio.toFixed(3)} exceeds ${verdict.threshold}`,
		);
		return 1;
	}
	return 0;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		process.exitCode = main();
	} catch (error) {
		console.error(`snapshot-persist ratio: failed: ${error?.message ?? error}`);
		process.exitCode = 2;
	}
}
