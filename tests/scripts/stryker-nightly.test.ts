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
import { selectMutationFiles } from "../../scripts/lib/stryker-diff.mjs";
import {
	buildNightlyBody,
	coverageGaps,
	MAX_PENDING,
	nextQueue,
	parsePending,
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

	// Recurrence (#4005 r3): the round-2 hold rule kept the marker whenever
	// anything was skipped, so on a busy streak (55-81 changed runtime files a
	// day) the window grew and the same top-weight files won every night. After
	// a completed run the marker always advances; what was skipped is queued.
	const covered = (extra: Record<string, unknown>) => ({
		files: {},
		piLensMutationDiff: {
			headSha: SHA_B,
			counts: { Killed: 3, Survived: 1 },
			rangesTotal: 4,
			rangesEvaluated: 4,
			partial: null,
			filesSelected: ["clients/a.ts", "clients/b.ts"],
			...extra,
		},
	});
	it.each([
		[
			"files skipped over the cap",
			covered({ filesSkippedOverCap: ["clients/c.ts"] }),
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
	])(
		"advances the marker for a completed run and says what was left for %s",
		(_label, incomplete, why) => {
			const body = buildNightlyBody({
				...meta,
				status: "ok",
				report: incomplete,
			});
			expect(parseLastReportSha([issue(body)], TITLE)).toBe(SHA_B);
			expect(body).toContain("**Status:** ok");
			expect(body).toMatch(/\*\*Coverage:\*\* not complete: /);
			expect(body).toMatch(why);
		},
	);

	it("reads a fully evaluated window as complete, with an empty queue", () => {
		const body = buildNightlyBody({
			...meta,
			status: "ok",
			report: covered({}),
		});
		expect(coverageGaps(covered({}))).toEqual({ capped: [], unfinished: [] });
		expect(body).toContain("the whole window was evaluated");
		expect(parsePending([issue(body)], TITLE).pending).toEqual([]);
	});

	describe("the carry-over queue", () => {
		const exists = () => true;
		const night = (options: Parameters<typeof nextQueue>[0]) =>
			nextQueue(options);

		it("queues the files skipped over the cap, in order, and re-queues unfinished ones at the back", () => {
			const result = night({
				oldPending: ["clients/old.ts"],
				oldPendingBase: SHA_A,
				base: SHA_B,
				status: "ok",
				report: covered({
					filesSkippedOverCap: ["clients/c.ts", "clients/d.ts"],
					rangesSampled: true,
				}),
				exists,
			});
			expect(result.pending).toEqual([
				"clients/old.ts",
				"clients/c.ts",
				"clients/d.ts",
				"clients/a.ts",
				"clients/b.ts",
			]);
			expect(result.pendingBase).toBe(SHA_A);
		});

		it("takes a queued file off the queue once it was fully evaluated", () => {
			const result = night({
				oldPending: ["clients/a.ts", "clients/z.ts"],
				oldPendingBase: SHA_A,
				base: SHA_B,
				status: "ok",
				report: covered({ filesSelected: ["clients/a.ts"] }),
				exists,
			});
			expect(result.pending).toEqual(["clients/z.ts"]);
			expect(result.pendingBase).toBe(SHA_A);
		});

		it("clears the queue base when the queue empties, and starts it at this window's base for new skips", () => {
			expect(
				night({
					oldPending: ["clients/a.ts"],
					oldPendingBase: SHA_A,
					base: SHA_B,
					status: "ok",
					report: covered({ filesSelected: ["clients/a.ts"] }),
					exists,
				}),
			).toMatchObject({ pending: [], pendingBase: null });
			expect(
				night({
					oldPending: ["clients/a.ts"],
					oldPendingBase: SHA_A,
					base: SHA_B,
					status: "ok",
					report: covered({
						filesSelected: ["clients/a.ts"],
						filesSkippedOverCap: ["clients/n.ts"],
					}),
					exists,
				}),
			).toMatchObject({ pending: ["clients/n.ts"], pendingBase: SHA_B });
		});

		// Recurrence: a file nobody can evaluate (no covering test, no source map)
		// re-queued forever by a sampled night.
		it("does not re-queue a taken file that could never be evaluated", () => {
			const result = night({
				oldPending: [],
				oldPendingBase: null,
				base: SHA_B,
				status: "ok",
				report: covered({
					rangesSampled: true,
					filesUncovered: ["clients/a.ts"],
				}),
				exists,
			});
			expect(result.pending).toEqual(["clients/b.ts"]);
		});

		// Recurrence (#4005 r3): a failed night must leave both the marker and
		// the queue as they were, or the queued files are lost with the window.
		it("leaves the marker and the queue unchanged for a failed run, and for an ok run with no report", () => {
			for (const [status, report] of [
				["failed", covered({ filesSkippedOverCap: ["clients/c.ts"] })],
				["failed", undefined],
				["ok", undefined],
			] as const) {
				const body = buildNightlyBody({
					...meta,
					status,
					report,
					oldPending: ["clients/q.ts"],
					oldPendingBase: SHA_A,
				});
				expect(parseLastReportSha([issue(body)], TITLE)).toBe(SHA_A);
				expect(parsePending([issue(body)], TITLE)).toEqual({
					pending: ["clients/q.ts"],
					pendingBase: SHA_A,
				});
				expect(body).toContain("**Status:** FAILED");
			}
		});

		// Recurrence: an overflowing queue growing the issue body, and the new
		// skips pushing out the oldest silently.
		it("drops the oldest beyond the bound and says so", () => {
			const old = Array.from({ length: 190 }, (_, i) => `clients/old-${i}.ts`);
			const skipped = Array.from(
				{ length: 30 },
				(_, i) => `clients/new-${i}.ts`,
			);
			const body = buildNightlyBody({
				...meta,
				status: "ok",
				report: covered({ filesSkippedOverCap: skipped, filesSelected: [] }),
				oldPending: old,
				oldPendingBase: SHA_A,
			});
			const { pending } = parsePending([issue(body)], TITLE);
			expect(MAX_PENDING).toBe(200);
			expect(pending).toHaveLength(200);
			expect(pending[0]).toBe("clients/old-20.ts");
			expect(pending.at(-1)).toBe("clients/new-29.ts");
			expect(body).toContain(
				"20 oldest file(s) were dropped because the queue overflowed",
			);
			expect(body.length).toBeLessThan(65_536);
		});

		it("drops a file that no longer exists, silently", () => {
			const result = night({
				oldPending: ["clients/gone.ts", "clients/kept.ts"],
				oldPendingBase: SHA_A,
				base: SHA_B,
				status: "ok",
				report: covered({ filesSelected: [] }),
				exists: (file) => file !== "clients/gone.ts",
			});
			expect(result.pending).toEqual(["clients/kept.ts"]);
			expect(result.dropped).toBe(0);
		});
	});

	// Recurrence (#4005 r3): the queue lives in an issue body a maintainer can
	// edit, and its paths reach `git diff` and Stryker's --mutate.
	describe("validating the queue on read", () => {
		const pendingOf = (entries: string) =>
			parsePending(
				[
					issue(
						`${markerOf(SHA_A)}\n<!-- stryker-nightly:pending=${entries} -->`,
					),
				],
				TITLE,
			).pending;

		it.each([
			["a parent-directory escape", "clients/../../etc/passwd.ts"],
			["an absolute path", "/etc/passwd.ts"],
			["a backslash path", "clients\\a.ts"],
			["a script outside the runtime tree", "scripts/a.mjs"],
			["a test file", "clients/a.test.ts"],
			["a declaration file", "clients/a.d.ts"],
			["a non-ts file", "clients/a.json"],
			["an option-looking path", "--output=x.ts"],
			["a shell-looking path", "clients/a;rm.ts"],
			["a dot segment", "clients/./a.ts"],
		])("ignores %s", (_label, entry) => {
			expect(pendingOf(`clients/ok.ts,${entry},tools/also-ok.ts`)).toEqual([
				"clients/ok.ts",
				"tools/also-ok.ts",
			]);
		});

		it("cannot be closed early by an injected comment terminator", () => {
			// Everything after the first terminator is outside the marker.
			expect(pendingOf("clients/a.ts --> <script>,clients/b.ts")).toEqual([
				"clients/a.ts",
			]);
		});

		it("accepts the runtime tree and dedupes", () => {
			expect(
				pendingOf(
					"index.ts,mcp/s.ts,tools/t.ts,clients/lsp/x.ts,clients/lsp/x.ts",
				),
			).toEqual(["index.ts", "mcp/s.ts", "tools/t.ts", "clients/lsp/x.ts"]);
		});

		// Recurrence: a survivor's source text quoting the marker later in the body
		// (this very file is mutated by the lane) becoming the queue.
		it("reads the first marker only, and an empty queue still writes one", () => {
			const body = buildNightlyBody({
				...meta,
				status: "ok",
				report: {
					files: {
						"clients/x.js": {
							mutants: [
								{
									status: "Survived",
									mutatorName: "M",
									original: "<!-- stryker-nightly:pending=clients/evil.ts -->",
									replacement: "x",
									location: { start: { line: 1 } },
								},
							],
						},
					},
					piLensMutationDiff: { counts: { Survived: 1 }, partial: null },
				},
			});
			expect(body).toContain("<!-- stryker-nightly:pending= -->");
			expect(body).toContain("stryker-nightly:pending=clients/evil.ts");
			expect(parsePending([issue(body)], TITLE).pending).toEqual([]);
		});

		it("ignores a queue edit on an issue that is not the tracking issue", () => {
			expect(
				parsePending(
					[issue("<!-- stryker-nightly:pending=clients/a.ts -->", "other")],
					TITLE,
				).pending,
			).toEqual([]);
		});
	});

	// The simulation: every changed file is eventually evaluated on a busy
	// streak. Each night runs the real pieces end to end: the queue read back
	// from the previous body, the real selection under the cap, a report shaped
	// like the driver's, and the real body.
	describe("a busy streak", () => {
		const CAP = 12;
		const files = (n: number) =>
			Array.from(
				{ length: n },
				(_, i) => `clients/day-file-${String(i).padStart(3, "0")}.ts`,
			);
		// Deterministic uneven weights so the by-weight cut has favourites.
		const weight = (file: string) =>
			((Number(file.match(/(\d+)\.ts$/)?.[1]) * 37) % 11) + 1;
		const holdRule = (windowFiles: string[], seen: Set<string>) => {
			// The round-2 hold rule as a control: marker held while anything was
			// skipped, so the window grows and the top weights win again.
			const picked = selectMutationFiles({
				windowFiles,
				maxFiles: CAP,
				weights: new Map(windowFiles.map((file) => [file, weight(file)])),
			});
			for (const file of picked.selected) seen.add(file);
			return picked.skipped.length === 0;
		};

		it("never evaluates some low-weight files under the round-2 hold rule (the control)", () => {
			const all = files(30 * 5);
			const seen = new Set<string>();
			let window: string[] = [];
			for (let day = 0; day < 5; day++) {
				window = [...window, ...all.slice(day * 30, day * 30 + 30)];
				if (holdRule(window, seen)) window = [];
			}
			expect(all.filter((file) => !seen.has(file)).length).toBeGreaterThan(0);
		});

		it("evaluates every changed file eventually under the carry-over queue", () => {
			const all = files(30 * 5);
			const evaluated = new Set<string>();
			let issueBody = "";
			let base = SHA_A;
			for (let night = 0; night < 5 + 14; night++) {
				const intake = night < 5 ? all.slice(night * 30, night * 30 + 30) : [];
				const { pending, pendingBase } = parsePending(
					[issue(issueBody)],
					TITLE,
				);
				const picked = selectMutationFiles({
					pending,
					windowFiles: [...pending, ...intake],
					maxFiles: CAP,
					weights: new Map(intake.map((file) => [file, weight(file)])),
				});
				expect(picked.selected.length).toBeLessThanOrEqual(CAP);
				for (const file of picked.selected) evaluated.add(file);
				issueBody = buildNightlyBody({
					base,
					head: SHA_B,
					source: "issue",
					status: "ok",
					report: covered({
						filesSelected: picked.selected,
						filesSkippedOverCap: picked.skipped,
					}),
					oldPending: pending,
					oldPendingBase: pendingBase,
				});
				base = SHA_B;
			}
			expect(all.filter((file) => !evaluated.has(file))).toEqual([]);
			expect(parsePending([issue(issueBody)], TITLE).pending).toEqual([]);
		});
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

		expect(main(args(issuesFile([issue(markerOf(old))])), repo)).toMatchObject({
			base: old,
			source: "issue",
		});
		// No issue: the newest commit older than 24 hours.
		expect(main(args(issuesFile([])), repo)).toMatchObject({
			base: mid,
			source: "fallback-no-issue",
			pending: [],
		});
		// A sha git does not know (rewritten history, hand-edited marker).
		expect(
			main(args(issuesFile([issue(markerOf("c".repeat(40)))])), repo),
		).toMatchObject({ base: mid, source: "fallback-bad-sha" });
	});

	// Recurrence: a repository younger than the window (the very first night)
	// has no commit older than 24 hours; the base must still resolve.
	it("`base` falls back to the root commit when nothing is older than the window", () => {
		const root = commit("root", new Date().toISOString());
		commit("next", new Date().toISOString());
		expect(
			main(["base", "--issues", issuesFile([]), "--title", TITLE], repo),
		).toMatchObject({ base: root, source: "fallback-no-issue" });
	});

	it("`body` writes the file the upsert reads, and a missing report degrades to a note", () => {
		const out = join(dir, "body.md");
		main(
			[
				"body",
				"--issues",
				issuesFile([]),
				"--title",
				TITLE,
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
		// No report is not a completed run: the marker stays at BASE.
		expect(parseLastReportSha([issue(body)], TITLE)).toBe(SHA_A);
		expect(body).toContain("No mutation report was produced");
	});

	it("`body` refuses a status it does not know", () => {
		expect(() =>
			main(
				[
					"body",
					"--issues",
					issuesFile([]),
					"--title",
					TITLE,
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

	// The queue through the real CLI seams: validated on read into the file the
	// driver gets, the base checked against git, and existence checked in the
	// checkout the body step runs in.
	it("`base` writes only the valid queue and a git-known queue base, and `body` drops a vanished file", () => {
		const first = commit("first", "2026-01-01T00:00:00Z");
		mkdirSync(join(repo, "clients"));
		writeFileSync(join(repo, "clients", "alive.ts"), "export {};\n");
		const stored = [
			"clients/alive.ts",
			"clients/vanished.ts",
			"../../etc/passwd.ts",
			"scripts/a.mjs",
		].join(",");
		const bodyWith = (queueBase: string) =>
			`${markerOf(first)}\n<!-- stryker-nightly:pending=${stored} -->\n<!-- stryker-nightly:pending-base=${queueBase} -->`;
		const pendingOut = join(dir, "pending.txt");
		const args = (file: string) => [
			"base",
			"--issues",
			file,
			"--title",
			TITLE,
			"--pending-out",
			pendingOut,
		];

		expect(
			main(args(issuesFile([issue(bodyWith(first))])), repo),
		).toMatchObject({
			pending: ["clients/alive.ts", "clients/vanished.ts"],
			pendingBase: first,
		});
		expect(readFileSync(pendingOut, "utf8")).toBe(
			"clients/alive.ts\nclients/vanished.ts\n",
		);
		// A queue base git does not know falls back (null), the queue stays.
		expect(
			main(args(issuesFile([issue(bodyWith("d".repeat(40)))])), repo),
		).toMatchObject({
			pending: ["clients/alive.ts", "clients/vanished.ts"],
			pendingBase: null,
		});

		const out = join(dir, "body.md");
		main(
			[
				"body",
				"--issues",
				issuesFile([issue(bodyWith(first))]),
				"--title",
				TITLE,
				"--base",
				first,
				"--head",
				SHA_B,
				"--source",
				"issue",
				"--status",
				"ok",
				"--report",
				(() => {
					const file = join(dir, "report.json");
					writeFileSync(
						file,
						JSON.stringify({
							files: {},
							piLensMutationDiff: {
								rangesTotal: 1,
								rangesEvaluated: 1,
								partial: null,
								counts: { Killed: 1 },
								filesSelected: [],
								filesSkippedOverCap: [
									"clients/alive.ts",
									"clients/new-gone.ts",
								],
							},
						}),
					);
					return file;
				})(),
				"--out",
				out,
			],
			repo,
		);
		expect(
			parsePending([issue(readFileSync(out, "utf8"))], TITLE).pending,
		).toEqual(["clients/alive.ts"]);
	});
});
