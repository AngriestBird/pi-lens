// flake-shape: real-process-spawn — `main base` resolves its window through real
// `git merge-base --is-ancestor` and `git rev-list --before` against a
// throwaway repo; ancestry and commit dates are the subject, and no in-process
// double reproduces git's answer for a rewritten or too-young history.
// #4005: the state and body halves of the nightly Stryker report. Recurrences
// each case keeps out are named in its comment. The git cases run against a
// throwaway repo through the real `main` seam (no mocked git); the issue list
// is the one GitHub boundary and is a literal `gh issue list --json` shape.
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";
import {
	buildNightlyBody,
	incompleteReasons,
	main,
	markerOf,
	parseLastReportSha,
	pickBase,
} from "../../scripts/stryker-nightly.mjs";

const TITLE =
	"nightly: Stryker test-adequacy report (runtime diff since the last report)";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const issue = (body: string, title = TITLE) => ({ title, body });

describe("parseLastReportSha", () => {
	it("reads the marker from the tracking issue's body", () => {
		expect(parseLastReportSha([issue(`${markerOf(SHA_A)}\ntext`)], TITLE)).toBe(
			SHA_A,
		);
	});

	// Recurrence: an unrelated open issue under the same label (or a marker
	// quoted in another issue's body) steering the window.
	it("ignores an issue whose title is not the tracking title", () => {
		expect(
			parseLastReportSha([issue(markerOf(SHA_A), "something else")], TITLE),
		).toBeNull();
	});

	// Recurrence: a half-written or hand-edited marker reading as a sha.
	it.each([
		["no marker", "report only"],
		["a short sha", "<!-- stryker-nightly:last-report-sha=abc123 -->"],
		["an uppercase sha", markerOf("A".repeat(40))],
		["a ref name", "<!-- stryker-nightly:last-report-sha=origin/master -->"],
	])("returns null for %s", (_label, body) => {
		expect(parseLastReportSha([issue(body)], TITLE)).toBeNull();
	});

	it("returns null when there is no issue at all", () => {
		expect(parseLastReportSha([], TITLE)).toBeNull();
		expect(parseLastReportSha(undefined as never, TITLE)).toBeNull();
	});
});

describe("pickBase", () => {
	const fallbackBase = () => SHA_B;

	it("uses the recorded sha when it is an ancestor of HEAD", () => {
		expect(
			pickBase({
				issues: [issue(markerOf(SHA_A))],
				title: TITLE,
				isAncestor: () => true,
				fallbackBase,
			}),
		).toEqual({ base: SHA_A, source: "issue" });
	});

	// Recurrence: the first night, or a maintainer closing the issue, leaving the
	// window open-ended (everything since the first commit).
	it("falls back to the bounded window when there is no issue", () => {
		expect(
			pickBase({
				issues: [],
				title: TITLE,
				isAncestor: () => true,
				fallbackBase,
			}),
		).toEqual({ base: SHA_B, source: "fallback-no-issue" });
	});

	// Recurrence: a rewritten history leaving `git diff <sha>..HEAD` to fail
	// every night with "bad revision" instead of reporting.
	it("falls back, and says so, when the recorded sha is not an ancestor", () => {
		expect(
			pickBase({
				issues: [issue(markerOf(SHA_A))],
				title: TITLE,
				isAncestor: () => false,
				fallbackBase,
			}),
		).toEqual({ base: SHA_B, source: "fallback-bad-sha" });
	});
});

describe("buildNightlyBody", () => {
	const meta = { base: SHA_A, head: SHA_B, source: "issue" } as const;
	const report = {
		files: {},
		piLensMutationDiff: {
			base: SHA_A,
			headSha: SHA_B,
			zeroMutants: { reason: "none" },
		},
	};

	it("advances the marker to HEAD for an ok run, which parseLastReportSha reads back", () => {
		const body = buildNightlyBody({ ...meta, status: "ok", report });
		expect(parseLastReportSha([issue(body)], TITLE)).toBe(SHA_B);
		expect(body).toContain("**Status:** ok");
		expect(body).toContain("### Mutation diff (advisory)");
	});

	// Recurrence (#4005 r2): the driver exits 0 when it skipped files over the
	// cap, sampled ranges away or ran out of budget, so `status=ok` advanced the
	// marker past files no later night revisits. Real windows: 2026-10-01 had 81
	// eligible runtime files and the top 12 were evaluated.
	const covered = (extra: Record<string, unknown>) => ({
		files: {},
		piLensMutationDiff: {
			headSha: SHA_B,
			counts: { Killed: 3, Survived: 1 },
			rangesTotal: 4,
			rangesEvaluated: 4,
			partial: null,
			...extra,
		},
	});
	it.each([
		[
			"files skipped over the cap",
			covered({ filesSkippedOverCap: ["clients/a.ts"] }),
			/1 file\(s\) skipped over the --max-files cap/,
		],
		[
			"sampled ranges",
			covered({ rangesSampled: true, rangesEvaluated: 2 }),
			/sampled 2 of 4/,
		],
		[
			"a budget-ended partial run",
			covered({ partial: { reason: "x", evaluated: 1, total: 9 } }),
			/partial run/,
		],
		[
			"ranges not all evaluated",
			covered({ rangesEvaluated: 1 }),
			/1 of 4 ranges evaluated/,
		],
		[
			"a zero-mutant run cut by the budget",
			{
				files: {},
				piLensMutationDiff: {
					rangesTotal: 4,
					measuredTotalMutants: 30,
					zeroMutants: { reason: "budget" },
				},
			},
			/no mutant was evaluated and the dry run measured some/,
		],
		["no report at all", undefined, /no mutation report/],
	])(
		"keeps the marker at BASE and says why for %s",
		(_label, incomplete, why) => {
			const body = buildNightlyBody({
				...meta,
				status: "ok",
				report: incomplete,
			});
			expect(parseLastReportSha([issue(body)], TITLE)).toBe(SHA_A);
			expect(body).toContain("**Status:** ok");
			expect(body).toMatch(
				/\*\*Marker:\*\* held at the window's base, because/,
			);
			expect(body).toMatch(why);
		},
	);

	it.each([
		["a fully evaluated window", covered({})],
		[
			"an early exit with nothing to mutate",
			{
				files: {},
				piLensMutationDiff: {
					zeroMutants: { reason: "no covering test" },
					filesUncovered: ["clients/a.ts"],
				},
			},
		],
		[
			"a dry run that measured no mutants",
			{
				files: {},
				piLensMutationDiff: {
					rangesTotal: 4,
					measuredTotalMutants: 0,
					zeroMutants: { reason: "none" },
				},
			},
		],
	])("advances the marker for %s", (_label, complete) => {
		expect(incompleteReasons(complete)).toEqual([]);
		expect(
			parseLastReportSha(
				[issue(buildNightlyBody({ ...meta, status: "ok", report: complete }))],
				TITLE,
			),
		).toBe(SHA_B);
	});

	// Recurrence (#4005 r2): GitHub refuses an issue body over 65536 characters;
	// a survivor table of every survivor, or a long tests-run list, would fail
	// the nightly's only write.
	it("stays under GitHub's body limit with 2000 survivors, and points at the artifact", () => {
		const survivors = Array.from({ length: 2000 }, (_, index) => ({
			status: "Survived",
			mutatorName: "ConditionalExpression",
			original: `${"original".repeat(60)}${index}`,
			replacement: "replacement".repeat(60),
			fileName: `clients/file-${index}.js`,
			tsLocation: { fileName: `clients/file-${index}.ts`, line: index + 1 },
		}));
		const huge = {
			files: { "clients/many.js": { mutants: survivors } },
			piLensMutationDiff: {
				headSha: SHA_B,
				rangesTotal: 1,
				rangesEvaluated: 1,
				partial: null,
				counts: { Survived: 2000 },
				testsRun: Array.from(
					{ length: 4000 },
					(_, i) => `tests/clients/t-${i}.test.ts`,
				),
			},
		};
		const body = buildNightlyBody({ ...meta, status: "ok", report: huge });
		expect(body.length).toBeLessThan(65_536);
		expect(body).toContain("#### Survivors (2000)");
		expect(body).toContain("Showing the first 50 of 2000 survivors");
		expect(body).toContain("`mutation-report` workflow artifact");
		expect(body.match(/^\| `clients\/file-/gm)).toHaveLength(50);
	});

	// Recurrence: a budget-killed or crashed night advancing the marker, so the
	// window it failed to evaluate is never evaluated.
	it("keeps the marker at BASE for a failed run, so tomorrow's window covers today's", () => {
		const body = buildNightlyBody({ ...meta, status: "failed" });
		expect(parseLastReportSha([issue(body)], TITLE)).toBe(SHA_A);
		expect(body).toContain("FAILED");
		expect(body).toContain("No mutation report was produced");
	});

	it("names the window, where the base came from, the run and the kill criterion", () => {
		const body = buildNightlyBody({
			...meta,
			source: "fallback-bad-sha",
			status: "ok",
			report,
			runUrl: "https://github.com/apmantza/pi-lens/actions/runs/1",
		});
		expect(body).toContain(`${SHA_A.slice(0, 12)}..${SHA_B.slice(0, 12)}`);
		expect(body).toContain("base from: fallback-bad-sha");
		expect(body).toContain("actions/runs/1");
		expect(body).toContain("Kill criterion");
		expect(body).toContain("gates nothing");
	});
});

describe("main (real git, real files)", () => {
	let dir: string;
	let repo: string;
	const git = (args: string[], date?: string) =>
		String(
			gitExecFileSync(
				["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
				{
					cwd: repo,
					encoding: "utf8",
					env: date
						? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
						: undefined,
				},
			),
		).trim();
	const commit = (name: string, date: string) => {
		writeFileSync(join(repo, name), `${name}\n`);
		git(["add", name]);
		git(["commit", "-qm", name], date);
		return git(["rev-parse", "HEAD"]);
	};
	const issuesFile = (issues: unknown) => {
		const file = join(dir, "issues.json");
		writeFileSync(file, JSON.stringify(issues));
		return file;
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-lens-stryker-nightly-"));
		repo = join(dir, "repo");
		mkdirSync(repo);
		git(["init", "-q"]);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("`base` returns the recorded ancestor and the bounded window otherwise", () => {
		const old = commit("old", "2026-01-01T00:00:00Z");
		const mid = commit("mid", "2026-01-02T00:00:00Z");
		commit("new", new Date().toISOString());
		const args = (file: string) => ["base", "--issues", file, "--title", TITLE];

		expect(main(args(issuesFile([issue(markerOf(old))])), repo)).toEqual({
			base: old,
			source: "issue",
		});
		// No issue: the newest commit older than 24 hours.
		expect(main(args(issuesFile([])), repo)).toEqual({
			base: mid,
			source: "fallback-no-issue",
		});
		// A sha git does not know (rewritten history, hand-edited marker).
		expect(
			main(args(issuesFile([issue(markerOf("c".repeat(40)))])), repo),
		).toEqual({ base: mid, source: "fallback-bad-sha" });
	});

	// Recurrence: a repository younger than the window (the very first night)
	// has no commit older than 24 hours; the base must still resolve.
	it("`base` falls back to the root commit when nothing is older than the window", () => {
		const root = commit("root", new Date().toISOString());
		commit("next", new Date().toISOString());
		expect(
			main(["base", "--issues", issuesFile([]), "--title", TITLE], repo),
		).toEqual({ base: root, source: "fallback-no-issue" });
	});

	it("`body` writes the file the upsert reads, and a missing report degrades to a note", () => {
		const out = join(dir, "body.md");
		main(
			[
				"body",
				"--base",
				SHA_A,
				"--head",
				SHA_B,
				"--source",
				"issue",
				"--status",
				"ok",
				"--report",
				join(dir, "absent.json"),
				"--out",
				out,
			],
			repo,
		);
		const body = readFileSync(out, "utf8");
		// No report means nothing was covered: the marker stays at BASE.
		expect(parseLastReportSha([issue(body)], TITLE)).toBe(SHA_A);
		expect(body).toContain("No mutation report was produced");
	});

	it("`body` refuses a status it does not know", () => {
		expect(() =>
			main(
				[
					"body",
					"--base",
					SHA_A,
					"--head",
					SHA_B,
					"--source",
					"issue",
					"--status",
					"maybe",
					"--out",
					join(dir, "body.md"),
				],
				repo,
			),
		).toThrow("--status must be ok or failed");
	});
});
