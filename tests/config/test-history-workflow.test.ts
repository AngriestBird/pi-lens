import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	METADATA_FILENAME,
	rowsFromArtifacts,
} from "../../scripts/test-history-rollup.mjs";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const root = path.resolve(import.meta.dirname, "../..");
const load = (file: string) =>
	yaml.load(fs.readFileSync(path.join(root, file), "utf8")) as Record<
		string,
		unknown
	>;

function steps(workflow: string, job: string) {
	const jobs = load(workflow).jobs as Record<string, unknown>;
	const target = jobs[job] as Record<string, unknown>;
	if (!target) throw new Error(`${workflow} has no ${job} job`);
	return target.steps as Array<Record<string, unknown>>;
}

function step(workflow: string, job: string, name: string) {
	const found = steps(workflow, job).find((entry) => entry.name === name);
	if (!found) throw new Error(`${workflow}#${job} has no "${name}" step`);
	return found;
}

describe("#3215 durable test-history workflow contract", () => {
	it("pins the reporter flags and the Linux artifact", () => {
		const command = String(
			step(".github/workflows/ci.yml", "test", "Run tests").run,
		);
		expect(command).toContain("--reporter=default");
		expect(command).toContain("--reporter=json");
		expect(command).toContain("--outputFile=");
		const upload = step(
			".github/workflows/ci.yml",
			"test",
			"Upload per-file test results",
		);
		const uploadWith = upload.with as Record<string, unknown>;
		// #3753: one artifact per Unit tests shard; the unsuffixed name is the
		// pre-sharding one (tests/config/unit-tests-shard-workflow.test.ts pins
		// the nightly's download list against the matrix).
		expect(uploadWith.name).toBe(
			"unit-test-results-linux-shard-${{ matrix.shard }}",
		);
		expect(upload.if).toBe("always()");
		const metadata = step(
			".github/workflows/ci.yml",
			"test",
			"Write test-history artifact metadata",
		);
		const metadataEnv = metadata.env as Record<string, unknown>;
		expect(metadataEnv.HEAD_SHA).toContain(
			"github.event.pull_request.head.sha",
		);
	});

	// Round 3 F8: the producer wrote and uploaded `test-history-metadata.json`
	// while `scripts/test-history-rollup.mjs` looked for a sibling
	// `metadata.json`, so the nightly rollup exited 2 on every real artifact and
	// lane 1 never wrote a row. The consumer's own exported constant is the one
	// source of truth, and both producer steps are asserted against it here —
	// not against a second copy of the string.
	it("writes and uploads exactly the basename the rollup consumer reads", () => {
		const metadata = step(
			".github/workflows/ci.yml",
			"test",
			"Write test-history artifact metadata",
		);
		expect(String(metadata.run)).toContain(`/${METADATA_FILENAME}`);
		const upload = step(
			".github/workflows/ci.yml",
			"test",
			"Upload per-file test results",
		);
		const paths = String((upload.with as Record<string, unknown>).path)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		expect(paths.map((entry) => path.posix.basename(entry))).toEqual([
			"vitest-results.json",
			METADATA_FILENAME,
		]);
	});

	// #3447: a re-run keeps its run id, so the attempt is what tells a failure
	// and its passing re-run apart in the journal. Runs the step's own
	// `node -e` program in process (no child spawn) under the env GitHub sets,
	// then hands what it wrote to the real consumer.
	it("records the run attempt the rollup keys re-runs by", async () => {
		const metadata = step(
			".github/workflows/ci.yml",
			"test",
			"Write test-history artifact metadata",
		);
		const program = /^node -e "([\s\S]*)"$/.exec(String(metadata.run).trim());
		if (!program) throw new Error("metadata step is not a `node -e` program");
		const temp = setupTestEnvironment("pi-lens-history-metadata-").tmpDir;
		try {
			const env = {
				RUNNER_TEMP: temp,
				HEAD_SHA: "c".repeat(40),
				GITHUB_RUN_ID: "36132594277",
				GITHUB_RUN_ATTEMPT: "2",
			};
			new Function("require", "process", program[1].replaceAll('\\"', '"'))(
				createRequire(import.meta.url),
				{ env },
			);
			fs.writeFileSync(
				path.join(temp, "vitest-results.json"),
				JSON.stringify({
					testResults: [{ name: "tests/x.test.ts", status: "passed" }],
				}),
			);
			const [row] = rowsFromArtifacts([temp]);
			expect(row).toMatchObject({
				headSha: env.HEAD_SHA,
				runId: env.GITHUB_RUN_ID,
				runAttempt: "2",
			});
		} finally {
			await cleanupTestEnvironmentsDrained("pi-lens-history-metadata-");
		}
	});

	// The additive `JSON report written to ...` line is CI-only: the local
	// `npm test` script must add no JSON reporter, so a developer's console
	// stream is untouched. The line's exact text and cardinality are pinned by
	// driving the real vitest JsonReporter in
	// `tests/scripts/test-history-rollup.test.ts`.
	it("keeps the JSON reporter out of the local npm test script", () => {
		const { scripts } = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(scripts.test).not.toContain("--reporter=json");
		expect(scripts.test).not.toContain("--outputFile");
	});

	it("runs the rollup job from the nightly and from a dispatch, with data-branch write access", () => {
		const workflow = load(".github/workflows/tool-smoke.yml");
		const jobs = workflow.jobs as Record<string, unknown>;
		const rollup = jobs["test-history-rollup"] as Record<string, unknown>;
		expect(rollup.if).toBe(
			"github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
		);
		const permissions = rollup.permissions as Record<string, unknown>;
		expect(permissions.contents).toBe("write");
	});
});

/**
 * #4030 review F1: the rollup job ran on any dispatched ref and its one step
 * pushed `data/test-history`, so a branch dispatch (run 37592572019) reached
 * the push with unreviewed rollup code; only GitHub's 100 MB limit stopped it.
 * The push now lives in one step, scoped like every other durable writer in
 * the file (schedule or master), and a branch dispatch only downloads and
 * rolls up.
 */
describe("test-history publish and notify scope (#4030)", () => {
	const PUBLISH_IF =
		"github.event_name == 'schedule' || github.ref == 'refs/heads/master'";
	const NOTIFY_IF = `always() && (${PUBLISH_IF})`;
	const rollupSteps = () =>
		steps(".github/workflows/tool-smoke.yml", "test-history-rollup");
	// Text a step runs, comments and quoted strings included: a push spelled
	// anywhere in a run block is a push.
	const runOf = (entry: Record<string, unknown>) => String(entry.run ?? "");

	it("pushes the data branch from exactly one step, and only on schedule or master", () => {
		const pushing = rollupSteps().filter((entry) =>
			/\bgit\s+push\b/.test(runOf(entry)),
		);
		expect(pushing.map((entry) => entry.name)).toEqual(["Publish data branch"]);
		expect(pushing[0].if).toBe(PUBLISH_IF);
		expect(runOf(pushing[0])).toContain("HEAD:data/test-history");
	});

	it("rolls up on every ref without touching the data branch", () => {
		const dry = step(
			".github/workflows/tool-smoke.yml",
			"test-history-rollup",
			"Roll up test history",
		);
		expect(dry.if).toBeUndefined();
		expect(runOf(dry)).toContain("test-history-rollup.mjs");
		expect(runOf(dry)).not.toMatch(/\bgit\s+(push|checkout|commit)\b/);
	});

	it("downloads incrementally after the journal's watermark", () => {
		const watermark = step(
			".github/workflows/tool-smoke.yml",
			"test-history-rollup",
			"Read the history watermark",
		);
		expect(watermark.id).toBe("watermark");
		expect(runOf(watermark)).toContain("--print-watermark");
		// Day lines first; the raw journal only as the one-time migration input.
		expect(runOf(watermark).indexOf("history/test-daily.ndjson")).toBeLessThan(
			runOf(watermark).indexOf("history/test-results.ndjson"),
		);
		const download = step(
			".github/workflows/tool-smoke.yml",
			"test-history-rollup",
			"Download unit-test result artifacts",
		);
		expect((download.env as Record<string, unknown>).SINCE).toBe(
			"${{ steps.watermark.outputs.since }}",
		);
		expect(runOf(download)).toContain('--since "$SINCE"');
	});

	it("publishes day lines and retires the raw journal", () => {
		const publish = runOf(
			step(
				".github/workflows/tool-smoke.yml",
				"test-history-rollup",
				"Publish data branch",
			),
		);
		expect(publish).toContain("history/test-daily.ndjson");
		expect(publish).toContain(
			"git rm -q --ignore-unmatch history/test-results.ndjson",
		);
	});

	// #4030 detection retrospective: six red nights were never alerted because
	// the tool-smoke notifier reads only the tool-smoke job.
	it("files, refreshes and closes a tracking issue for a red rollup, as the last step", () => {
		const all = rollupSteps();
		const notify = all.at(-1) as Record<string, unknown>;
		expect(notify.name).toBe(
			"Notify on test-history rollup red (file/update/close tracking issue)",
		);
		expect(notify.if).toBe(NOTIFY_IF);
		expect(notify["continue-on-error"]).toBe(true);
		expect((notify.env as Record<string, unknown>).JOB_STATUS).toBe(
			"${{ job.status }}",
		);
		const run = runOf(notify);
		expect(run).toContain('[ "$JOB_STATUS" = failure ]');
		expect(run).toMatch(
			/node "\$cli" --title "\$TITLE" --label nightly-drift --body-file/,
		);
		expect(run).toMatch(
			/node "\$cli" --title "\$TITLE" --label nightly-drift --clean --close-when-clean/,
		);
		// The publish step checks out the data branch, so the CLI runs from the
		// scripts staged before it.
		expect(run).toContain(
			'cli="$RUNNER_TEMP/history-scripts/upsert-tracking-issue.mjs"',
		);
		expect(
			runOf(
				step(
					".github/workflows/tool-smoke.yml",
					"test-history-rollup",
					"Read the history watermark",
				),
			),
		).toContain('cp -r scripts "$RUNNER_TEMP/history-scripts"');
		const jobs = load(".github/workflows/tool-smoke.yml").jobs as Record<
			string,
			Record<string, unknown>
		>;
		expect(
			(jobs["test-history-rollup"].permissions as Record<string, unknown>)
				.issues,
		).toBe("write");
	});
});
