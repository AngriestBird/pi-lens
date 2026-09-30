// #3801: scripts/ci-heavy-gate.mjs decides whether ci.yml's heavy advisory
// jobs (mutation, the Windows Vitest subset) may start. Every case names the
// recurrence it keeps out. Time is a fake clock and a recording sleep; nothing
// here waits for real.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	decideGate,
	parseArgs,
	run,
	waitForRequired,
} from "../../scripts/ci-heavy-gate.mjs";

const SHA = "a".repeat(40);
const REQUIRED = ["knip", "oxfmt format check"];

function cr(
	name: string,
	status: string,
	conclusion: string | null,
	startedAt = "2026-09-30T10:00:00Z",
) {
	return { name, status, conclusion, started_at: startedAt };
}
const green = (startedAt?: string) => [
	cr("knip", "completed", "success", startedAt),
	cr("oxfmt format check", "completed", "success", startedAt),
];

describe("decideGate", () => {
	it("is ready only when every named check's latest run concluded success", () => {
		expect(decideGate(green(), REQUIRED).state).toBe("ready");
	});

	// Recurrence: starting the heavy jobs on a head whose required lint.yml check
	// is red (the wrong direction: real failures stop gating the lane's cost).
	it.each([
		"failure",
		"cancelled",
		"timed_out",
		"skipped",
		"neutral",
		"action_required",
	])("blocks on a %s conclusion", (conclusion) => {
		const decision = decideGate(
			[
				cr("knip", "completed", conclusion),
				cr("oxfmt format check", "completed", "success"),
			],
			REQUIRED,
		);
		expect(decision.state).toBe("blocked");
		expect(decision.detail).toContain(`knip (${conclusion})`);
	});

	// Recurrence: a check that has not registered yet (absent) or is still
	// running reading as passed. Both wait.
	it("waits on an absent or unfinished check", () => {
		expect(decideGate([cr("knip", "completed", "success")], REQUIRED)).toEqual({
			state: "wait",
			detail: "not finished: oxfmt format check",
		});
		expect(
			decideGate(
				[
					cr("knip", "in_progress", null),
					cr("oxfmt format check", "queued", null),
				],
				REQUIRED,
			).state,
		).toBe("wait");
	});

	// Recurrence (ci-checks.mjs's own #2190 lesson): a superseded success with a
	// newer in-flight or red rerun for the same name must not release the gate.
	it("reads the LATEST run per name, so a stale success cannot outvote a newer rerun", () => {
		const rows = [
			cr("knip", "completed", "success", "2026-09-30T10:00:00Z"),
			cr("knip", "in_progress", null, "2026-09-30T10:05:00Z"),
			cr("oxfmt format check", "completed", "success"),
		];
		expect(decideGate(rows, REQUIRED).state).toBe("wait");
		rows[1] = cr("knip", "completed", "failure", "2026-09-30T10:05:00Z");
		expect(decideGate(rows, REQUIRED).state).toBe("blocked");
	});

	// A red row decides at once even while another check is still pending:
	// waiting cannot make it green.
	it("blocks immediately on a red row even while another check is unfinished", () => {
		const decision = decideGate([cr("knip", "completed", "failure")], REQUIRED);
		expect(decision.state).toBe("blocked");
	});
});

describe("waitForRequired", () => {
	function clock() {
		let t = 1_000_000;
		return {
			now: () => t,
			sleep: (ms: number) => void (t += ms),
			slept: () => t - 1_000_000,
		};
	}

	it("polls until the checks finish, then releases the gate", () => {
		const c = clock();
		let calls = 0;
		const result = waitForRequired({
			fetchRuns: () =>
				++calls < 3 ? [cr("knip", "in_progress", null)] : green(),
			required: REQUIRED,
			deadlineMs: 300_000,
			intervalMs: 15_000,
			now: c.now,
			sleep: c.sleep,
		});
		expect(result.ready).toBe(true);
		expect(calls).toBe(3);
		expect(c.slept()).toBe(30_000);
	});

	// Recurrence: an unbounded wait holding a runner slot (the very resource
	// this gate exists to save) when a check never registers.
	it("gives up at the deadline with ready=false and names what never finished", () => {
		const c = clock();
		const result = waitForRequired({
			fetchRuns: () => [],
			required: REQUIRED,
			deadlineMs: 60_000,
			intervalMs: 15_000,
			now: c.now,
			sleep: c.sleep,
		});
		expect(result.ready).toBe(false);
		expect(result.reason).toMatch(
			/not finished: knip, oxfmt format check after \d+s/,
		);
		expect(c.slept()).toBeLessThanOrEqual(60_000);
	});

	it("does not poll again after a red row", () => {
		const c = clock();
		let calls = 0;
		const result = waitForRequired({
			fetchRuns: () => (calls++, [cr("knip", "completed", "failure")]),
			required: REQUIRED,
			deadlineMs: 300_000,
			intervalMs: 15_000,
			now: c.now,
			sleep: c.sleep,
		});
		expect(result).toEqual({
			ready: false,
			reason: "not green: knip (failure)",
		});
		expect(calls).toBe(1);
		expect(c.slept()).toBe(0);
	});

	// Recurrence (AGENTS.md shape 48, fallback direction): an unreadable API
	// must not be read as "green". The harm of the other direction is a skipped
	// advisory job, which a rerun recovers; running them on an unread head is
	// the wasted-slot failure this gate exists to prevent.
	it("treats a failed read as not ready, never as green and never as a crash", () => {
		const result = waitForRequired({
			fetchRuns: () => {
				throw new Error("HTTP 502: bad gateway\nsecond line");
			},
			required: REQUIRED,
			deadlineMs: 60_000,
			intervalMs: 15_000,
		});
		expect(result).toEqual({
			ready: false,
			reason: "check-runs unreadable: HTTP 502: bad gateway",
		});
	});
});

describe("run (the CLI the workflow step calls)", () => {
	function tmpFiles() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-heavy-gate-"));
		return {
			dir,
			output: path.join(dir, "output"),
			summary: path.join(dir, "summary"),
		};
	}
	const argv = [
		"--repo",
		"apmantza/pi-lens",
		"--sha",
		SHA,
		"--require",
		"knip",
		"--require",
		"oxfmt format check",
	];

	// Recurrence: the workflow's `outputs.ready` and this script drifting (a
	// renamed output key) makes every dependent's `if:` false forever, so the
	// heavy lanes silently never run. The key the workflow reads is `ready`.
	it("appends ready=true to GITHUB_OUTPUT and exits 0 when the checks are green", () => {
		const files = tmpFiles();
		try {
			const lines: string[] = [];
			const code = run(argv, {
				env: {
					GITHUB_OUTPUT: files.output,
					GITHUB_STEP_SUMMARY: files.summary,
				},
				fetchRuns: (repo: string, sha: string) => {
					expect([repo, sha]).toEqual(["apmantza/pi-lens", SHA]);
					return green();
				},
				log: (line: string) => lines.push(line),
			});
			expect(code).toBe(0);
			expect(fs.readFileSync(files.output, "utf8")).toBe("ready=true\n");
			expect(lines[0]).toMatch(/^heavy advisory jobs: START -- /);
			expect(fs.readFileSync(files.summary, "utf8")).toBe(`${lines[0]}\n`);
		} finally {
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("appends ready=false and still exits 0 when a check is red", () => {
		const files = tmpFiles();
		try {
			const code = run(argv, {
				env: { GITHUB_OUTPUT: files.output },
				fetchRuns: () => [
					cr("knip", "completed", "failure"),
					cr("oxfmt format check", "completed", "success"),
				],
				log: () => {},
			});
			expect(code).toBe(0);
			expect(fs.readFileSync(files.output, "utf8")).toBe("ready=false\n");
		} finally {
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("rejects bad arguments with exit 2 and writes no output", () => {
		const files = tmpFiles();
		try {
			const bad = [
				[],
				["--repo", "nope", "--sha", SHA, "--require", "knip"],
				["--repo", "a/b", "--sha", "abc123", "--require", "knip"],
				["--repo", "a/b", "--sha", SHA],
				[
					"--repo",
					"a/b",
					"--sha",
					SHA,
					"--require",
					"knip",
					"--deadline-seconds",
					"0",
				],
				["--repo", "a/b", "--sha", SHA, "--require", "knip", "--bogus", "x"],
			];
			for (const args of bad) {
				expect(
					run(args, {
						env: { GITHUB_OUTPUT: files.output },
						fetchRuns: () => green(),
						log: () => {},
					}),
				).toBe(2);
			}
			expect(fs.existsSync(files.output)).toBe(false);
		} finally {
			fs.rmSync(files.dir, { recursive: true, force: true });
		}
	});

	it("parses the workflow's exact argument shape", () => {
		expect(parseArgs(argv)).toMatchObject({
			repo: "apmantza/pi-lens",
			sha: SHA,
			required: ["knip", "oxfmt format check"],
			deadlineSeconds: 300,
			intervalSeconds: 15,
		});
	});
});
