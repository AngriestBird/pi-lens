/**
 * scripts/lib/ci-job-p90.mjs (#4691, item 3 of #3920): the pure computation
 * behind the nightly p90-vs-timeout warning. Nothing here fetches. The CLI
 * (scripts/check-ci-job-p90.mjs) reads ci.yml and the recent master runs and
 * hands the parsed data in; tests feed a recorded fixture.
 *
 * Required jobs come from REQUIRED_CHECKS (scripts/lib/ci-checks.mjs), the one
 * required-checks list. A ci.yml job is required when its display name, cut at
 * the first " (", is a required check: `Unit tests (shard ${{ ... }})` is the
 * `test` matrix behind the `Unit tests` aggregate, so both keys are admitted.
 * A row from a run matches a job when the row's name fits the job's name with
 * each `${{ ... }}` read as a wildcard.
 *
 * The cap is the job's own `timeout-minutes`. A warning fires when the p90 of
 * the job's samples is strictly over P90_CAP_RATIO of that cap. One warning per
 * job key per run, never one per shard sample (#4691 acceptance 3).
 */
import { escapeRegExp } from "../../clients/string-utils.js";
import { REQUIRED_CHECKS } from "./ci-checks.mjs";

/** The threshold: warn when p90 is over this fraction of `timeout-minutes`. */
export const P90_CAP_RATIO = 0.7;

/** A job display name as a matcher: each `${{ ... }}` is a wildcard. */
function nameMatcher(name) {
	const literal = name
		.split(/\$\{\{.*?\}\}/)
		.map(escapeRegExp)
		.join(".+?");
	return new RegExp(`^${literal}$`);
}

/**
 * The required jobs of a parsed ci.yml, each with its cap in minutes.
 * A job with no numeric `timeout-minutes` keeps `capMinutes: null`; the
 * computation reports it as skipped rather than guessing a cap.
 *
 * @param {{ jobs?: Record<string, any> }} workflow parsed ci.yml
 * @returns {Array<{ key: string, name: string, display: string, matcher: RegExp, capMinutes: number | null }>}
 */
export function requiredJobSpecs(workflow) {
	const specs = [];
	for (const [key, job] of Object.entries(workflow?.jobs ?? {})) {
		const name = typeof job?.name === "string" ? job.name : key;
		const family = name.split(" (")[0].trim();
		if (!REQUIRED_CHECKS.includes(family)) continue;
		const cap = job["timeout-minutes"];
		specs.push({
			key,
			name,
			display: name.replace(/\$\{\{.*?\}\}/g, "*"),
			matcher: nameMatcher(name),
			capMinutes: typeof cap === "number" && cap > 0 ? cap : null,
		});
	}
	return specs;
}

/**
 * Nearest-rank p90: the value at rank ceil(0.9 n) of the ascending samples.
 * Returns undefined for no samples.
 *
 * @param {number[]} values
 */
export function p90(values) {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

/** A row's duration in seconds, or null for a row that did not run. */
function durationSeconds(job) {
	if (job?.conclusion === "skipped") return null;
	const started = Date.parse(job?.started_at ?? "");
	const completed = Date.parse(job?.completed_at ?? "");
	if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
	const seconds = (completed - started) / 1000;
	return seconds > 0 ? seconds : null;
}

/**
 * The p90 check over recent runs.
 *
 * @param {object} input
 * @param {ReturnType<typeof requiredJobSpecs>} input.specs
 * @param {Array<{ id: number, created_at: string, jobs: any[] }>} input.runs
 *   recorded master runs with their job rows (gh api shape)
 * @param {number} [input.ratio]
 * @returns {{
 *   warnings: Array<{ key: string, name: string, display: string, p90Seconds: number,
 *     capSeconds: number, ratio: number, samples: number,
 *     window: { runs: number, from: string, to: string } }>,
 *   skipped: Array<{ key: string, reason: string }>,
 * }}
 */
export function p90Warnings({ specs, runs, ratio = P90_CAP_RATIO }) {
	const warnings = [];
	const skipped = [];
	for (const spec of specs) {
		if (spec.capMinutes === null) {
			skipped.push({ key: spec.key, reason: "no numeric timeout-minutes" });
			continue;
		}
		const samples = [];
		const dates = [];
		for (const run of runs) {
			let contributed = false;
			for (const job of run.jobs ?? []) {
				if (!spec.matcher.test(String(job?.name ?? ""))) continue;
				const seconds = durationSeconds(job);
				if (seconds === null) continue;
				samples.push(seconds);
				contributed = true;
			}
			if (contributed) dates.push(String(run.created_at).slice(0, 10));
		}
		if (samples.length === 0) {
			skipped.push({ key: spec.key, reason: "no samples" });
			continue;
		}
		const value = p90(samples);
		const capSeconds = spec.capMinutes * 60;
		if (value > ratio * capSeconds) {
			dates.sort();
			warnings.push({
				key: spec.key,
				name: spec.name,
				display: spec.display,
				p90Seconds: value,
				capSeconds,
				ratio,
				samples: samples.length,
				window: {
					runs: runs.length,
					from: dates[0],
					to: dates[dates.length - 1],
				},
			});
		}
	}
	return { warnings, skipped };
}

/**
 * The one-line warning a workflow annotation carries. It names the job, the p90,
 * the cap and the window the samples came from.
 *
 * @param {ReturnType<typeof p90Warnings>["warnings"][number]} w
 */
export function formatP90Warning(w) {
	const percent = ((w.p90Seconds / w.capSeconds) * 100).toFixed(1);
	const capMinutes = w.capSeconds / 60;
	return (
		`ci.yml job ${w.key} "${w.display}": p90 ${w.p90Seconds} s is ${percent}% ` +
		`of its ${w.capSeconds} s cap (timeout-minutes ${capMinutes}); ` +
		`window ${w.window.runs} master runs ${w.window.from} to ${w.window.to}; ` +
		`${w.samples} samples`
	);
}
