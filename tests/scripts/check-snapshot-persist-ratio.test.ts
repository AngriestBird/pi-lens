/**
 * Nightly snapshot-persist drift check (#3916, recurrence of #3789).
 *
 * Recurrences this file prevents:
 *  - the #3789 shape itself: a change puts a structured clone (or a second
 *    serialization) back on the worker persist path and nothing on master
 *    notices until a user reports the RSS spike. The threshold tests read the
 *    raw bench reports of the cloning tree (4.3.0) and of the fixed tree and
 *    require the committed threshold to separate them with a margin, so a
 *    threshold edit that no longer separates the measured trees reds here;
 *  - a threshold loosened (or tightened) without a measurement behind it;
 *  - the nightly job rewired so it no longer reds on drift, reaches the
 *    tracking issue through a second mechanism, or widens its permissions.
 *
 * It never re-measures: an RSS assertion on a shared CI runner would flake.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	buildDriftBody,
	DRIFT_THRESHOLD,
	evaluate,
	firstPersistRatio,
	main,
} from "../../scripts/check-snapshot-persist-ratio.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const fixture = (name: string) =>
	JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures", name), "utf8"));

interface Report {
	results: { mode: string; runs: { persist: number; rssJumpMB: number }[] }[];
}
const calibration = fixture("snapshot-persist-nightly-calibration.json") as {
	healthy: Report[];
	regressed: Report[];
};
const measurement = fixture("snapshot-persist-measurement.json") as {
	rounds: { before: Report[]; after: Report[] };
};
const healthy = [...calibration.healthy, ...measurement.rounds.after];
const regressed = [...calibration.regressed, ...measurement.rounds.before];

const report = (workerMB: number, syncMB: number): Report => ({
	results: [
		{ mode: "worker", runs: [{ persist: 0, rssJumpMB: workerMB }] },
		{ mode: "sync", runs: [{ persist: 0, rssJumpMB: syncMB }] },
	],
});

describe("DRIFT_THRESHOLD separates the measured trees (#3916)", () => {
	it("holds the measured populations the constant was chosen from", () => {
		expect(healthy).toHaveLength(11);
		expect(regressed).toHaveLength(9);
	});

	it("sits at least 5% above every fixed-tree run and 5% below every cloning-tree run", () => {
		const healthyWorst = Math.max(
			...healthy.map((r) => firstPersistRatio(r).ratio),
		);
		const regressedBest = Math.min(
			...regressed.map((r) => firstPersistRatio(r).ratio),
		);
		expect(DRIFT_THRESHOLD).toBeGreaterThanOrEqual(healthyWorst * 1.05);
		expect(DRIFT_THRESHOLD).toBeLessThanOrEqual(regressedBest / 1.05);
	});

	it("calls every fixed-tree run clean and every cloning-tree run drift", () => {
		expect(healthy.map((r) => evaluate(r).state)).toEqual(
			healthy.map(() => "clean"),
		);
		expect(regressed.map((r) => evaluate(r).state)).toEqual(
			regressed.map(() => "drift"),
		);
	});
});

describe("evaluate", () => {
	it("treats a ratio exactly at the threshold as clean and anything above as drift", () => {
		expect(evaluate(report(DRIFT_THRESHOLD * 100, 100)).state).toBe("clean");
		expect(evaluate(report(DRIFT_THRESHOLD * 100 + 1, 100)).state).toBe(
			"drift",
		);
	});

	it("reads persist 0, not a later persist", () => {
		const warm = report(100, 100);
		warm.results[0].runs.push({ persist: 1, rssJumpMB: 900 });
		expect(evaluate(warm)).toMatchObject({ state: "clean", ratio: 1 });
	});

	it.each([
		["no results", {}],
		["no sync result", { results: [report(100, 100).results[0]] }],
		[
			"no persist 0",
			{
				results: [
					{ mode: "worker", runs: [{ persist: 1, rssJumpMB: 9 }] },
					report(1, 1).results[1],
				],
			},
		],
		["a zero sync jump", report(100, 0)],
		["a non-numeric jump", report(Number.NaN, 100)],
	])(
		"reports an unusable report (%s) as error, never as a verdict",
		(_name, bad) => {
			const verdict = evaluate(bad);
			expect(verdict.state).toBe("error");
			expect(verdict.reason).toContain("persist 0");
		},
	);
});

describe("main (the CLI the workflow runs)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});
	const run = (bench: unknown, extra: string[] = []) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-snapshot-ratio-"));
		dirs.push(dir);
		const reportPath = join(dir, "report.json");
		const body = join(dir, "out", "drift.md");
		const state = join(dir, "out", "state");
		mkdirSync(join(dir, "out"));
		writeFileSync(
			reportPath,
			typeof bench === "string" ? bench : JSON.stringify(bench),
		);
		writeFileSync(body, "stale body from an earlier night");
		const lines: string[] = [];
		const code = main(
			["--report", reportPath, "--body", body, "--state", state, ...extra],
			(line: string) => lines.push(line),
		);
		const read = (path: string) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		};
		return { code, lines, body: read(body), state: read(state)?.trim() };
	};

	it("drift: exit 1, state drift, a body with the figures and the run URL", () => {
		const out = run(regressed[0], [
			"--run-url",
			"https://example.invalid/run/1",
		]);
		expect(out.code).toBe(1);
		expect(out.state).toBe("drift");
		expect(out.body).toContain(String(DRIFT_THRESHOLD));
		expect(out.body).toContain("https://example.invalid/run/1");
		expect(out.lines.join("\n")).toContain("::error::");
	});

	it("clean: exit 0, state clean, and a stale drift body is removed", () => {
		const out = run(healthy[0]);
		expect(out.code).toBe(0);
		expect(out.state).toBe("clean");
		expect(out.body).toBeUndefined();
	});

	it("unusable report: exit 2, state error, no drift body (the issue is left alone)", () => {
		for (const bad of ["not json", {}]) {
			const out = run(bad);
			expect(out.code).toBe(2);
			expect(out.state).toBe("error");
			expect(out.body).toBeUndefined();
		}
	});

	it("requires --report", () => {
		expect(() => main([], () => {})).toThrow("--report is required");
	});
});

describe("buildDriftBody", () => {
	it("states the ratio, the threshold and the runner", () => {
		const verdict = evaluate(report(300, 120));
		const body = buildDriftBody(verdict, {
			report: { node: "v22.1.0", platform: "linux x64" },
		});
		expect(body).toContain("**2.500**");
		expect(body).toContain(`**${DRIFT_THRESHOLD}**`);
		expect(body).toContain("v22.1.0 on linux x64");
	});
});

describe("tool-smoke.yml snapshot-persist-bench wiring (#3916)", () => {
	type Step = {
		name?: string;
		id?: string;
		if?: string;
		run?: string;
		"continue-on-error"?: boolean;
		"timeout-minutes"?: number;
	};
	type Job = {
		permissions?: Record<string, string>;
		"timeout-minutes"?: number;
		steps: Step[];
	};
	const source = readFileSync(
		resolve(ROOT, ".github/workflows/tool-smoke.yml"),
		"utf8",
	);
	const jobs = (yaml.load(source) as { jobs: Record<string, Job> }).jobs;
	const job = jobs["snapshot-persist-bench"];
	const step = (needle: string) => {
		const found = job.steps.find((candidate) =>
			String(candidate.run ?? "").includes(needle),
		);
		if (!found) throw new Error(`no step runs ${needle}`);
		return found;
	};

	it("is a nightly job with the narrowest permissions that can write the tracking issue", () => {
		expect(job).toBeDefined();
		expect(job.permissions).toEqual({ contents: "read", issues: "write" });
		// The tool-smoke job's own grant is unchanged: this lane widens nothing.
		expect(jobs["tool-smoke"].permissions).toEqual({
			contents: "write",
			"pull-requests": "write",
			issues: "write",
		});
	});

	it("bounds the bench step below the job bound", () => {
		expect(step("bench-snapshot-persist.mjs")["timeout-minutes"]).toBeLessThan(
			job["timeout-minutes"] as number,
		);
	});

	it("benches, checks, then notifies, passing the same report and state paths", () => {
		const names = job.steps.map((s) => String(s.run ?? ""));
		const at = (needle: string) =>
			names.findIndex((run) => run.includes(needle));
		expect(at("bench-snapshot-persist.mjs")).toBeGreaterThan(
			at("npm run build"),
		);
		expect(at("check-snapshot-persist-ratio.mjs")).toBeGreaterThan(
			at("bench-snapshot-persist.mjs"),
		);
		expect(at("upsert-tracking-issue.mjs")).toBeGreaterThan(
			at("check-snapshot-persist-ratio.mjs"),
		);
		const bench = step("bench-snapshot-persist.mjs").run as string;
		const check = step("check-snapshot-persist-ratio.mjs").run as string;
		const notify = step("upsert-tracking-issue.mjs").run as string;
		expect(bench).toContain('--out "$RUNNER_TEMP/snapshot-persist-bench.json"');
		expect(check).toContain(
			'--report "$RUNNER_TEMP/snapshot-persist-bench.json"',
		);
		const state = /--state "([^"]+)"/.exec(check)?.[1];
		const body = /--body "([^"]+)"/.exec(check)?.[1];
		expect(state && notify.includes(state)).toBe(true);
		expect(body && notify.includes(body)).toBe(true);
	});

	it("lets a drift verdict red the job but never lets the notifier do so", () => {
		expect(
			step("check-snapshot-persist-ratio.mjs")["continue-on-error"],
		).toBeUndefined();
		const notify = step("upsert-tracking-issue.mjs");
		expect(notify["continue-on-error"]).toBe(true);
		expect(notify.if).toBe(
			"always() && (github.event_name == 'schedule' || github.ref == 'refs/heads/master')",
		);
	});

	it("reaches the tracking issue only through the shared CLI", () => {
		const own = job.steps.map((s) => String(s.run ?? "")).join("\n");
		expect(own).toContain("--label nightly-drift");
		expect(own).toContain("--close-when-clean");
		expect(own).not.toMatch(/gh issue (create|edit|comment|close)/);
	});
});
