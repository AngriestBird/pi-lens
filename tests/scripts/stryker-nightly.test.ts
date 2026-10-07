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
	collectChangedRanges,
	partitionMutationFiles,
	selectMutationFiles,
} from "../../scripts/lib/stryker-diff.mjs";
import {
	buildNightlyBody,
	combineShardReports,
	combinedShardStatus,
	coverageGaps,
	MAX_BASE_AGE_DAYS,
	MAX_PENDING,
	nextQueue,
	parsePending,
	main,
	markerOf,
	parseLastReportSha,
	pickBase,
	SHARD_STATE_SPACE,
} from "../../scripts/stryker-nightly.mjs";

const TITLE =
	"nightly: Stryker test-adequacy report (runtime diff since the last report)";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const issue = (body: string, title = TITLE) => ({ title, body });
// A queue as `parsePending` reads it: `[file, base]` pairs, nothing re-based.
const queueOf = (pairs: Array<[string, string | null]>) => ({
	entries: pairs.map(([file, base]) => ({ file, base })),
	rebased: 0,
	unknownBase: 0,
	floor: null,
});
const filesOf = (body: string) =>
	parsePending([issue(body)], TITLE).entries.map((entry) => entry.file);

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

describe("nightly shard partition and publication", () => {
	it("partitions the selected 24 disjointly and preserves the skipped queue owner", () => {
		const selected = Array.from(
			{ length: 24 },
			(_, index) => `clients/f${index}.ts`,
		);
		const skipped = ["clients/f24.ts"];
		const first = partitionMutationFiles({
			selected,
			skipped,
			shardIndex: 0,
			shardCount: 2,
		});
		const second = partitionMutationFiles({
			selected,
			skipped,
			shardIndex: 1,
			shardCount: 2,
		});
		expect(new Set(first.selected).size).toBe(12);
		expect(new Set(second.selected).size).toBe(12);
		expect(
			first.selected.filter((file) => second.selected.includes(file)),
		).toEqual([]);
		expect([...first.selected, ...second.selected].sort()).toEqual(
			[...selected].sort(),
		);
		expect(first.skipped).toEqual(skipped);
		expect(second.skipped).toEqual([]);
	});

	it("combines reports without losing either shard's files or counts", () => {
		const report = (file: string, status: string) => ({
			files: { [file]: { status } },
			piLensMutationDiff: {
				filesSelected: [file],
				filesSkippedOverCap: [],
				rangesTotal: 2,
				rangesEvaluated: 1,
				measuredTotalMutants: 3,
				counts: { Killed: 1 },
				partial: false,
			},
		});
		const combined = combineShardReports([
			report("clients/a.ts", "ok"),
			report("clients/b.ts", "partial"),
		]);
		expect(combined).toMatchObject({
			files: {
				"clients/a.ts": { status: "ok" },
				"clients/b.ts": { status: "partial" },
			},
			piLensMutationDiff: {
				filesSelected: ["clients/a.ts", "clients/b.ts"],
				rangesTotal: 4,
				rangesEvaluated: 2,
				measuredTotalMutants: 6,
				counts: { Killed: 2 },
			},
		});
	});

	// Recurrence (#4038 F1): publish must not treat the artifacts that happened
	// to arrive as the matrix. A missing shard must hold the queue and marker.
	it("`combine` fails closed when an expected shard artifact is missing", () => {
		const combineDir = mkdtempSync(join(tmpdir(), "pi-lens-stryker-combine-"));
		try {
			const inputs = join(combineDir, "inputs.json");
			const out = join(combineDir, "report.json");
			const outcomes = join(combineDir, "outcomes.json");
			writeFileSync(
				inputs,
				JSON.stringify([{ shard: 0, outcome: "complete", report: out }]),
			);
			const result = main([
				"combine",
				"--inputs",
				inputs,
				"--expected-shards",
				"0,1",
				"--out",
				out,
				"--outcomes",
				outcomes,
			]);
			const combineStatus = (result as { status: "ok" | "failed" }).status;
			expect(result).toMatchObject({ status: "failed", report: undefined });
			expect(JSON.parse(readFileSync(outcomes, "utf8"))).toMatchObject({
				status: "failed",
				report: false,
			});
			const oldEntries = [{ file: "clients/missing.ts", base: SHA_A }];
			expect(
				nextQueue({
					oldEntries,
					base: SHA_B,
					status: combineStatus,
					exists: () => true,
				}).entries,
			).toEqual(oldEntries);
			const body = buildNightlyBody({
				base: SHA_A,
				head: SHA_B,
				source: "issue",
				status: combineStatus,
			});
			expect(parseLastReportSha([issue(body)], TITLE)).toBe(SHA_A);
		} finally {
			rmSync(combineDir, { recursive: true, force: true });
		}
	});

	it.each(SHARD_STATE_SPACE)(
		"records the state space: %s + %s",
		(left, right, queue, report) => {
			expect([left, right, queue, report]).toHaveLength(4);
			expect(combinedShardStatus([left as never, right as never])).toBe(
				left === "failed" || right === "failed" ? "failed" : "ok",
			);
		},
	);
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
		expect(filesOf(body)).toEqual([]);
	});

	describe("the carry-over queue", () => {
		const exists = () => true;
		const night = (options: Parameters<typeof nextQueue>[0]) =>
			nextQueue(options);

		it("queues the files skipped over the cap, in order, and re-queues unfinished ones at the back", () => {
			const result = night({
				oldEntries: [{ file: "clients/old.ts", base: SHA_A }],
				base: SHA_B,
				status: "ok",
				report: covered({
					filesSkippedOverCap: ["clients/c.ts", "clients/d.ts"],
					rangesSampled: true,
				}),
				exists,
			});
			expect(result.entries.map((entry) => entry.file)).toEqual([
				"clients/old.ts",
				"clients/c.ts",
				"clients/d.ts",
				"clients/a.ts",
				"clients/b.ts",
			]);
		});

		it("takes a queued file off the queue once it was fully evaluated", () => {
			const result = night({
				oldEntries: [
					{ file: "clients/a.ts", base: SHA_A },
					{ file: "clients/z.ts", base: SHA_A },
				],
				base: SHA_B,
				status: "ok",
				report: covered({ filesSelected: ["clients/a.ts"] }),
				exists,
			});
			expect(result.entries).toEqual([{ file: "clients/z.ts", base: SHA_A }]);
		});

		// Recurrence (#4005 r4, N1): one shared queue base, pinned to the oldest
		// contributing night while any old entry stayed, so under a sustained
		// overload every carried file (yesterday's too) was re-read from night 0.
		// The write-side rule: an entry keeps its own base; a file new to the
		// queue, or one read without a base, gets this night's window base.
		it("keeps each entry's own base across re-queues and gives a new skip this window's base", () => {
			const result = night({
				oldEntries: [
					{ file: "clients/waiting.ts", base: SHA_A },
					{ file: "clients/no-base.ts", base: null },
					{ file: "clients/a.ts", base: SHA_C },
				],
				base: SHA_B,
				status: "ok",
				report: covered({
					filesSkippedOverCap: ["clients/new.ts"],
					rangesSampled: true,
				}),
				exists,
			});
			expect(result.entries).toEqual([
				{ file: "clients/waiting.ts", base: SHA_A },
				{ file: "clients/no-base.ts", base: SHA_B },
				{ file: "clients/new.ts", base: SHA_B },
				{ file: "clients/a.ts", base: SHA_C },
				{ file: "clients/b.ts", base: SHA_B },
			]);
			expect(
				night({
					oldEntries: [{ file: "clients/a.ts", base: SHA_A }],
					base: SHA_B,
					status: "ok",
					report: covered({ filesSelected: ["clients/a.ts"] }),
					exists,
				}).entries,
			).toEqual([]);
		});

		// Recurrence: a file nobody can evaluate (no covering test, no source map)
		// re-queued forever by a sampled night.
		it("does not re-queue a taken file that could never be evaluated", () => {
			const result = night({
				oldEntries: [],
				base: SHA_B,
				status: "ok",
				report: covered({
					rangesSampled: true,
					filesUncovered: ["clients/a.ts"],
				}),
				exists,
			});
			expect(result.entries.map((entry) => entry.file)).toEqual([
				"clients/b.ts",
			]);
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
					previous: queueOf([["clients/q.ts", SHA_A]]),
				});
				expect(parseLastReportSha([issue(body)], TITLE)).toBe(SHA_A);
				expect(parsePending([issue(body)], TITLE).entries).toEqual([
					{ file: "clients/q.ts", base: SHA_A },
				]);
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
				previous: queueOf(old.map((file) => [file, SHA_A])),
			});
			const pending = filesOf(body);
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
				oldEntries: [
					{ file: "clients/gone.ts", base: SHA_A },
					{ file: "clients/kept.ts", base: SHA_A },
				],
				base: SHA_B,
				status: "ok",
				report: covered({ filesSelected: [] }),
				exists: (file) => file !== "clients/gone.ts",
			});
			expect(result.entries).toEqual([
				{ file: "clients/kept.ts", base: SHA_A },
			]);
			expect(result.dropped).toBe(0);
		});
	});

	// Recurrence (#4005 r3): the queue lives in an issue body a maintainer can
	// edit, and its paths reach `git diff` and Stryker's --mutate.
	describe("validating the queue on read", () => {
		const pendingOf = (entries: string) =>
			filesOf(
				`${markerOf(SHA_A)}\n<!-- stryker-nightly:pending=${entries} -->`,
			);

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
			["an option-looking base", "clients/a.ts@--output"],
			["a short base", "clients/a.ts@abc123"],
			["an uppercase base", `clients/a.ts@${"A".repeat(40)}`],
			["two bases", `clients/a.ts@${SHA_A}@${SHA_A}`],
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
			expect(filesOf(body)).toEqual([]);
		});

		it("ignores a queue edit on an issue that is not the tracking issue", () => {
			expect(
				parsePending(
					[issue("<!-- stryker-nightly:pending=clients/a.ts -->", "other")],
					TITLE,
				).entries,
			).toEqual([]);
		});

		// Recurrence (#4005 r4): a per-entry base comes from an editable body
		// and reaches `git diff <base>...HEAD`. A base git does not know as an
		// ancestor of HEAD (a rewritten history, a hand edit) drops the base,
		// never the file, and is counted; so is an entry with no base.
		it("keeps the file but drops a base git does not know, and counts both kinds", () => {
			const read = parsePending(
				[
					issue(
						`<!-- stryker-nightly:pending=clients/a.ts@${SHA_A},clients/b.ts@${SHA_C},clients/c.ts -->`,
					),
				],
				TITLE,
				{
					isAncestor: (sha) => sha === SHA_A,
					floor: null,
					isOlderThanFloor: () => false,
				},
			);
			expect(read).toEqual({
				entries: [
					{ file: "clients/a.ts", base: SHA_A },
					{ file: "clients/b.ts", base: null },
					{ file: "clients/c.ts", base: null },
				],
				rebased: 0,
				unknownBase: 2,
				floor: null,
			});
			const body = buildNightlyBody({
				...meta,
				status: "ok",
				report: covered({ filesSelected: [] }),
				previous: read,
			});
			expect(body).toContain(
				"2 queued file(s) had no base git knows as an ancestor and were read against the window base",
			);
			// Written back with this night's window base: read once without one.
			expect(parsePending([issue(body)], TITLE).entries).toEqual([
				{ file: "clients/a.ts", base: SHA_A },
				{ file: "clients/b.ts", base: SHA_A },
				{ file: "clients/c.ts", base: SHA_A },
			]);
		});

		// Recurrence (#4005 r4): a re-queued (sampled) file cycling with its
		// base growing older every night. Past MAX_BASE_AGE_DAYS the base is
		// moved to the floor and the body says how many lost their history.
		it("re-bases an entry older than the floor onto it and says so; one at the floor is not counted", () => {
			const read = parsePending(
				[
					issue(
						`<!-- stryker-nightly:pending=clients/old.ts@${SHA_A},clients/at.ts@${SHA_B},clients/new.ts@${SHA_C} -->`,
					),
				],
				TITLE,
				{
					isAncestor: () => true,
					floor: SHA_B,
					isOlderThanFloor: (sha) => sha !== SHA_C,
				},
			);
			expect(MAX_BASE_AGE_DAYS).toBe(14);
			expect(read).toEqual({
				entries: [
					{ file: "clients/old.ts", base: SHA_B },
					{ file: "clients/at.ts", base: SHA_B },
					{ file: "clients/new.ts", base: SHA_C },
				],
				rebased: 1,
				unknownBase: 0,
				floor: SHA_B,
			});
			const body = buildNightlyBody({
				...meta,
				status: "failed",
				previous: read,
			});
			expect(body).toContain(
				`1 queued file(s) had a base older than 14 days and were re-based onto \`${SHA_B.slice(0, 12)}\`, so their earlier changes are not evaluated`,
			);
			expect(parsePending([issue(body)], TITLE).entries).toEqual(read.entries);
		});
	});

	// The simulation: every changed file is eventually evaluated on a busy
	// streak. Each night runs the real pieces end to end: the queue read back
	// from the previous body, the real selection under the cap, a report shaped
	// like the driver's, and the real body.
	describe("a busy streak", () => {
		const CAP = 24;
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
				const previous = parsePending([issue(issueBody)], TITLE);
				const pending = previous.entries.map((entry) => entry.file);
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
					previous,
				});
				base = SHA_B;
			}
			expect(all.filter((file) => !evaluated.has(file))).toEqual([]);
			expect(filesOf(issueBody)).toEqual([]);
		});

		// Recurrence (#4005 r4, N1): under a sustained overload the round-3 shared
		// queue base stayed at the first overloaded night, so carried files were
		// re-read against an ever older base, their growing diffs pushed nights
		// into sampling, and sampling re-queues every taken file.
		// Model: night n's HEAD is sha(n), its window base sha(n - 1), one night
		// standing for one day (the floor is sha(n - 14)). A pool of 150 runtime
		// files, 30 changed a night in rotation (5 to 15 lines a change), so a
		// file is re-touched every fifth night: 30 a night against a 24-file cap.
		// A night samples when the taken files' lines exceed `budget`, each
		// file's lines counted since the base the real collectChangedRanges split
		// reads it against. The queue is read, selected and written by the real
		// parsePending, selectMutationFiles and buildNightlyBody.
		const overload = (budget: number) => {
			const NIGHTS = 60;
			const sha = (night: number) => (night + 2).toString(16).padStart(40, "0");
			const nightOf = (value: string) => Number.parseInt(value, 16) - 2;
			const changedOn = (night: number) =>
				Array.from({ length: 30 }, (_, j) => (night * 30 + j) % 150);
			const nameOf = (i: number) => `clients/pool-${i}.ts`;
			const linesSince = (file: string, from: string, head: number) => {
				const i = Number(file.match(/pool-(\d+)\.ts$/)?.[1]);
				let total = 0;
				for (let k = nightOf(from) + 1; k <= head; k++)
					if (changedOn(k).includes(i)) total += 5 + ((i * 7) % 11);
				return total;
			};
			let issueBody = "";
			let maxAge = 0;
			let rebased = 0;
			const evaluatedPerNight: number[] = [];
			for (let night = 0; night < NIGHTS; night++) {
				const windowBase = sha(night - 1);
				const floorNight = night - MAX_BASE_AGE_DAYS;
				const previous = parsePending([issue(issueBody)], TITLE, {
					isAncestor: () => true,
					floor: floorNight >= -1 ? sha(floorNight) : null,
					isOlderThanFloor: (value) => nightOf(value) <= floorNight,
				});
				rebased += previous.rebased;
				const pending = previous.entries.map((entry) => entry.file);
				const readBase = new Map<string, string>();
				const all = [...new Set([...pending, ...changedOn(night).map(nameOf)])];
				collectChangedRanges({
					files: all,
					baseRef: windowBase,
					baseOf: new Map(
						previous.entries.flatMap((entry) =>
							entry.base ? [[entry.file, entry.base] as const] : [],
						),
					),
					diff: (from, subset) => {
						for (const file of subset) readBase.set(file, from);
						return new Map();
					},
				});
				const picked = selectMutationFiles({
					pending,
					windowFiles: all,
					maxFiles: 24,
					weights: new Map(
						all.map((file) => [
							file,
							linesSince(file, readBase.get(file) as string, night),
						]),
					),
				});
				let lines = 0;
				for (const file of picked.selected) {
					const from = readBase.get(file) as string;
					lines += linesSince(file, from, night);
					maxAge = Math.max(maxAge, night - nightOf(from));
				}
				const sampled = lines > budget;
				evaluatedPerNight.push(sampled ? 0 : picked.selected.length);
				issueBody = buildNightlyBody({
					base: windowBase,
					head: sha(night),
					source: "issue",
					status: "ok",
					report: covered({
						filesSelected: picked.selected,
						filesSkippedOverCap: picked.skipped,
						rangesTotal: 10,
						rangesEvaluated: sampled ? 5 : 10,
						rangesSampled: sampled,
					}),
					previous,
				});
			}
			const steady = evaluatedPerNight.slice(20);
			return {
				maxAge,
				rebased,
				throughput: steady.reduce((sum, n) => sum + n, 0) / steady.length,
			};
		};

		it("keeps the base age bounded and the throughput up under a steady overload", () => {
			const { maxAge, throughput } = overload(600);
			expect.soft(maxAge).toBeLessThanOrEqual(MAX_BASE_AGE_DAYS + 1);
			expect.soft(throughput).toBeGreaterThanOrEqual(10);
		});

		// Recurrence (#4005 r4): per-entry bases alone leave a file that is
		// re-queued every night (sampled every time) cycling with an ever older
		// base. The floor bounds it, and the re-basing is counted.
		it("bounds the base age of files re-queued every night, and counts the re-basing", () => {
			const { maxAge, rebased } = overload(-1);
			expect(maxAge).toBeLessThanOrEqual(MAX_BASE_AGE_DAYS + 1);
			expect(rebased).toBeGreaterThan(0);
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
			queue: { entries: [] },
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

	const reportFile = (meta: Record<string, unknown>) => {
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
					...meta,
				},
			}),
		);
		return file;
	};
	const bodyArgs = (issues: string, base: string, report: string) => [
		"body",
		"--issues",
		issues,
		"--title",
		TITLE,
		"--base",
		base,
		"--head",
		SHA_B,
		"--source",
		"issue",
		"--status",
		"ok",
		"--report",
		report,
		"--out",
		join(dir, "body.md"),
	];
	const baseArgs = (issues: string) => [
		"base",
		"--issues",
		issues,
		"--title",
		TITLE,
		"--pending-out",
		join(dir, "pending.txt"),
	];

	// The queue through the real CLI seams: validated on read into the file the
	// driver gets, each entry's base checked against git, and existence checked
	// in the checkout the body step runs in.
	it("`base` writes only the valid queue with git-known bases, and `body` drops a vanished file", () => {
		const first = commit("first", "2026-01-01T00:00:00Z");
		mkdirSync(join(repo, "clients"));
		writeFileSync(join(repo, "clients", "alive.ts"), "export {};\n");
		const issues = issuesFile([
			issue(
				`${markerOf(first)}\n<!-- stryker-nightly:pending=${[
					`clients/alive.ts@${first}`,
					`clients/vanished.ts@${"d".repeat(40)}`,
					`../../etc/passwd.ts@${first}`,
					"scripts/a.mjs",
				].join(",")} -->`,
			),
		]);

		expect(main(baseArgs(issues), repo)).toMatchObject({
			queue: {
				entries: [
					{ file: "clients/alive.ts", base: first },
					{ file: "clients/vanished.ts", base: null },
				],
				unknownBase: 1,
			},
		});
		expect(readFileSync(join(dir, "pending.txt"), "utf8")).toBe(
			`clients/alive.ts@${first}\nclients/vanished.ts\n`,
		);

		main(
			bodyArgs(
				issues,
				first,
				reportFile({
					filesSkippedOverCap: ["clients/alive.ts", "clients/new-gone.ts"],
				}),
			),
			repo,
		);
		const body = readFileSync(join(dir, "body.md"), "utf8");
		expect(parsePending([issue(body)], TITLE).entries).toEqual([
			{ file: "clients/alive.ts", base: first },
		]);
		expect(body).toContain("1 queued file(s) had no base git knows");
	});

	// Recurrence (#4005 r4, N1): the base of a queued file growing without
	// bound. Real commit dates: HEAD is 2026-01-30, so the floor is the newest
	// first-parent commit on or before 2026-01-16. A merged side branch's commit
	// dated 01-15 is newer by date but is not on master's line: as the floor it
	// would diff from its fork point, so it must not be chosen.
	it("`base` re-bases an entry older than 14 days onto the floor, and `body` writes the same base back", () => {
		mkdirSync(join(repo, "clients"));
		for (const name of ["a", "b", "c"])
			writeFileSync(join(repo, "clients", `${name}.ts`), "export {};\n");
		const c0 = commit("c0", "2026-01-01T00:00:00Z");
		const trunk = git(["rev-parse", "--abbrev-ref", "HEAD"]);
		const c1 = commit("c1", "2026-01-10T00:00:00Z");
		git(["checkout", "-q", "-b", "side", c0]);
		commit("side", "2026-01-15T00:00:00Z");
		git(["checkout", "-q", trunk]);
		const c2 = commit("c2", "2026-01-20T00:00:00Z");
		git(
			["merge", "--no-ff", "-q", "-m", "merge", "side"],
			"2026-01-25T00:00:00Z",
		);
		commit("c3", "2026-01-30T00:00:00Z");
		const issues = issuesFile([
			issue(
				`${markerOf(c2)}\n<!-- stryker-nightly:pending=clients/a.ts@${c0},clients/b.ts@${c1},clients/c.ts@${c2} -->`,
			),
		]);
		const read = {
			entries: [
				{ file: "clients/a.ts", base: c1 },
				{ file: "clients/b.ts", base: c1 },
				{ file: "clients/c.ts", base: c2 },
			],
			rebased: 1,
			unknownBase: 0,
			floor: c1,
		};

		expect(main(baseArgs(issues), repo)).toMatchObject({ queue: read });
		expect(readFileSync(join(dir, "pending.txt"), "utf8")).toBe(
			`clients/a.ts@${c1}\nclients/b.ts@${c1}\nclients/c.ts@${c2}\n`,
		);
		main(bodyArgs(issues, c2, reportFile({})), repo);
		const body = readFileSync(join(dir, "body.md"), "utf8");
		expect(parsePending([issue(body)], TITLE).entries).toEqual(read.entries);
		expect(body).toContain(
			`1 queued file(s) had a base older than 14 days and were re-based onto \`${c1.slice(0, 12)}\``,
		);
	});
});
