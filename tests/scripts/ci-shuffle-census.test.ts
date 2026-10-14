// #4405: scripts/ci-shuffle-census.mjs runs every test file alone and inside
// shuffled chunks under three seeds, and diffs the order-dependent members it
// finds against scripts/shuffle-census-ratchet.json. Every case names the
// recurrence it keeps out. The vitest start is the only process boundary and
// is injected here; the real start is `ci-shuffle-changed-tests-spawn.test.ts`
// and the real whole-tree pass is the command itself (its runtime and the
// re-broken-fix reds are quoted in the PR body).
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	CENSUS_SEEDS,
	CHUNK_FILES,
	extractMembers,
	judgeCensus,
	loadRecords,
	MIN_START_MS,
	parseArgs,
	planCensus,
	planConfirms,
	run,
	runCensus,
	START_CAP_MS,
	type CensusRecord,
	type Member,
	type RatchetEntry,
	type Seed,
} from "../../scripts/ci-shuffle-census.mjs";
import { type ExecVitest } from "../../scripts/ci-shuffle-changed-tests.mjs";
import { setupTestEnvironment } from "../clients/test-utils.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function scratchDir(name: string): string {
	const scratch = setupTestEnvironment(`pi-lens-4405-${name}-`);
	cleanups.push(scratch.cleanup);
	return scratch.tmpDir;
}

const quiet = () => {};
const ESC = String.fromCharCode(27);
const paint = (code: string, text: string) =>
	`${ESC}[${code}m${text}${ESC}[39m`;
/** One vitest FAIL banner as CI prints it: colour codes, project label. */
const banner = (file: string, test?: string) =>
	`${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m |default| ${file}${test ? `${ESC}[2m > ${ESC}[22m${test}` : ""}`;

function member(
	file: string,
	test: string,
	firstError = "Error: boom",
): Member {
	return { file, test, firstError };
}
function record(
	seed: Seed,
	files: string[],
	members: Member[],
	extra: Partial<CensusRecord> = {},
): CensusRecord {
	return {
		key: `npx vitest run ${files.join(" ")} ${seed}`,
		kind: "census",
		label: `${seed} ${files[0]}`,
		files,
		seed,
		verdict: members.length > 0 ? "red" : "ok",
		ms: 1,
		members,
		...extra,
	};
}
function confirm(seed: number, file: string, members: Member[]): CensusRecord {
	return record(seed, [file], members, {
		kind: "confirm",
		key: `confirm ${seed} ${file}`,
	});
}
const entry = (file: string, seed: number, test: string): RatchetEntry => ({
	file,
	seed,
	test,
	seam: "x",
});

describe("extractMembers", () => {
	// Recurrence: a census that reads colour-split FAIL banners as "no failing
	// test" lists no member at all (AGENTS.md shape 63: CI runs vitest with
	// colour, and a project label sits between FAIL and the file).
	it("reads file, test and first error from coloured banners", () => {
		const out = [
			"stdout noise",
			banner("tests/a.test.ts", "suite > case one"),
			`${paint("31", "AssertionError")}: expected 1 to be 2`,
			"",
			banner("tests/b.test.ts", "case two"),
			"",
			`${paint("31", "TypeError")}: x is not a function`,
		].join("\n");
		expect(extractMembers(out)).toEqual([
			member(
				"tests/a.test.ts",
				"suite > case one",
				"AssertionError: expected 1 to be 2",
			),
			member("tests/b.test.ts", "case two", "TypeError: x is not a function"),
		]);
	});

	// Recurrence: #4405's index-integration member. Vitest prints one error
	// under the LAST of N banners that share it; reading the next line as the
	// error recorded another test's banner for 14 of 25 members.
	it("skips a following FAIL banner when it looks for the first error line", () => {
		const out = [
			banner("tests/a.test.ts", "one"),
			banner("tests/a.test.ts", "two"),
			"Error: shared cause",
		].join("\n");
		expect(extractMembers(out).map((m) => m.firstError)).toEqual([
			"Error: shared cause",
			"Error: shared cause",
		]);
	});

	// Recurrence: a suite that failed to collect (a missing import) has a
	// banner with no test name; it is still a member, under a sentinel.
	it("names a file-level failure with the (file) sentinel", () => {
		expect(
			extractMembers(
				`${banner("tests/c.test.ts")}\nError: Cannot find module './x.js'`,
			),
		).toEqual([
			member("tests/c.test.ts", "(file)", "Error: Cannot find module './x.js'"),
		]);
	});

	// Recurrence: vitest repeats a banner in its inline list and its summary;
	// counting both doubles a member and the ratchet then lists it twice.
	it("lists a repeated banner once", () => {
		const block = `${banner("tests/a.test.ts", "one")}\nError: x`;
		expect(extractMembers(`${block}\n${block}`)).toHaveLength(1);
	});
});

describe("planCensus", () => {
	const files = Array.from(
		{ length: 7 },
		(_, index) => `tests/f${index}.test.ts`,
	);

	// Recurrence: a census that drops a file at a chunk boundary, or runs one
	// twice, reports a member count that is not about the tree.
	it("covers every file once per seed and once alone", () => {
		const plan = planCensus(files, { seeds: [1, 2], chunk: 3 });
		for (const seed of [1, 2]) {
			const covered = plan
				.filter((start) => start.flags.includes(`--sequence.seed=${seed}`))
				.flatMap((start) => start.files);
			expect(covered).toEqual(files);
		}
		const alone = plan.filter((start) => start.flags.length === 0);
		expect(alone.map((start) => start.files)).toEqual(files.map((f) => [f]));
		expect(plan).toHaveLength(2 * 3 + 7);
	});

	// Recurrence: drift between the census seeds and the changed-files job's
	// (202, 424) would let a member the PR job misses hide, or a PR job red
	// the census never saw.
	it("uses the changed-files seeds plus a third", () => {
		expect([...CENSUS_SEEDS]).toEqual([202, 424, 606]);
		expect(CHUNK_FILES).toBeGreaterThan(1);
	});

	// Recurrence: a confirm start reusing a census key would be skipped as
	// done, so a member would stay unconfirmed forever.
	it("plans one confirm start per shuffled member file and seed, never for alone", () => {
		const records = [
			record(
				202,
				["tests/a.test.ts", "tests/b.test.ts"],
				[member("tests/a.test.ts", "t1"), member("tests/a.test.ts", "t2")],
			),
			record("alone", ["tests/c.test.ts"], [member("tests/c.test.ts", "t")]),
		];
		const confirms = planConfirms(records);
		expect(
			confirms.map((start) => [start.files, start.flags, start.kind]),
		).toEqual([
			[
				["tests/a.test.ts"],
				["--sequence.shuffle", "--sequence.seed=202"],
				"confirm",
			],
		]);
	});
});

describe("runCensus", () => {
	const okExec: ExecVitest = () => ({ status: 0, output: "", timedOut: false });
	const plan = () =>
		planCensus(["tests/a.test.ts", "tests/b.test.ts"], {
			seeds: [202],
			chunk: 2,
		});

	// Recurrence: an hours-long pass that cannot resume restarts from zero after
	// every cut call; a rerun must skip what the records hold.
	it("records each finished start and skips recorded ones on a rerun", () => {
		const dir = scratchDir("resume");
		const outFile = path.join(dir, "census.0-of-1.jsonl");
		const starts: string[] = [];
		const exec: ExecVitest = (start) => {
			starts.push(start.files.join(","));
			return {
				status: 1,
				output: `${banner(start.files[0] ?? "", "case")}\nError: bad`,
				timedOut: false,
			};
		};
		const first = runCensus(plan(), {
			cwd: dir,
			outFile,
			done: new Set(),
			budgetMs: 10 * MIN_START_MS,
			exec,
			log: quiet,
		});
		expect(first).toEqual({ ran: 3, pending: 0 });
		const records = loadRecords(dir);
		expect(records.map((r) => r.verdict)).toEqual(["red", "red", "red"]);
		expect(records[0]?.members[0]).toEqual(
			member("tests/a.test.ts", "case", "Error: bad"),
		);
		const second = runCensus(plan(), {
			cwd: dir,
			outFile,
			done: new Set(records.map((r) => r.key)),
			budgetMs: 10 * MIN_START_MS,
			exec,
			log: quiet,
		});
		expect(second).toEqual({ ran: 0, pending: 0 });
		expect(starts).toHaveLength(3);
	});

	// Recurrence: a start the call budget cut recorded as "timeout" is counted
	// as a member-free finished start and never rerun.
	it("does not record a start the call budget cut, and leaves it pending", () => {
		const dir = scratchDir("cut");
		let clock = 0;
		const exec: ExecVitest = (_start, { timeoutMs }) => {
			clock += timeoutMs;
			return { status: null, output: "", timedOut: true };
		};
		const outFile = path.join(dir, "census.0-of-1.jsonl");
		const result = runCensus(plan(), {
			cwd: dir,
			outFile,
			done: new Set(),
			budgetMs: START_CAP_MS / 2,
			exec,
			now: () => clock,
			log: quiet,
		});
		expect(result.ran).toBe(0);
		expect(result.pending).toBe(3);
		expect(fs.existsSync(outFile)).toBe(false);
	});

	// Recurrence: a start never begun with less than MIN_START_MS left would
	// be cut mid-run and its fork left behind.
	it("begins no start under MIN_START_MS of budget", () => {
		const dir = scratchDir("min");
		let began = 0;
		const result = runCensus(plan(), {
			cwd: dir,
			outFile: path.join(dir, "census.0-of-1.jsonl"),
			done: new Set(),
			budgetMs: MIN_START_MS - 1,
			exec: (...args) => {
				began += 1;
				return okExec(...args);
			},
			log: quiet,
		});
		expect(began).toBe(0);
		expect(result.pending).toBe(3);
	});

	// Recurrence: a start that used its whole cap and timed out is a real
	// answer (a hung file), recorded so the verdict is "unproven", not retried
	// forever.
	it("records a start that timed out at the full cap", () => {
		const dir = scratchDir("cap");
		let clock = 0;
		const result = runCensus(plan().slice(0, 1), {
			cwd: dir,
			outFile: path.join(dir, "census.0-of-1.jsonl"),
			done: new Set(),
			budgetMs: 10 * START_CAP_MS,
			exec: (_start, { timeoutMs }) => {
				clock += timeoutMs;
				return { status: null, output: "", timedOut: true };
			},
			now: () => clock,
			log: quiet,
		});
		expect(result.ran).toBe(1);
		expect(loadRecords(dir)[0]?.verdict).toBe("timeout");
	});
});

describe("redo-unproven", () => {
	const A = "tests/a.test.ts";
	const writeRecords = (dir: string, records: CensusRecord[]) =>
		fs.writeFileSync(
			path.join(dir, "census.0-of-1.jsonl"),
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);

	// Recurrence: #4405's full pass lost one alone start to a stale-build guard
	// another part tripped; without a redo the census stays "unproven" forever.
	it("reruns the starts whose record proved nothing, and only those", () => {
		const dir = scratchDir("redo");
		const out = path.join(dir, "out");
		fs.mkdirSync(out);
		const files = [A, "tests/b.test.ts"];
		const planned = planCensus(files, { seeds: [], chunk: 2 });
		const [first, second] = planned.map((start) =>
			record("alone", start.files, [], {
				key: `npx vitest run ${start.files[0]}`,
				verdict: start.files[0] === A ? "uncollected" : "ok",
				at: 1,
			}),
		) as [CensusRecord, CensusRecord];
		writeRecords(out, [first, second]);
		const starts: string[] = [];
		const exec: ExecVitest = (start) => {
			starts.push(start.files.join(","));
			return { status: 0, output: "", timedOut: false };
		};
		const args = ["--out", out, "--cwd", dir, "--files", files.join(",")];
		// Without the flag only the never-run shuffled chunk starts.
		expect(run([...args, "--seeds", "202"], { exec, log: quiet })).toBe(0);
		expect(starts).toEqual([files.join(",")]);
		starts.length = 0;
		expect(
			run([...args, "--seeds", "202", "--redo-unproven"], { exec, log: quiet }),
		).toBe(0);
		expect(starts).toEqual([A]);
	});

	// Recurrence: two records for one start (the unproven one and its redo)
	// both reaching the judge would read the redo's green as a second start
	// and the old uncollected as still open.
	it("loads the latest record per start", () => {
		const dir = scratchDir("latest");
		writeRecords(dir, [
			record(202, [A], [], { key: "k", verdict: "uncollected", at: 1 }),
			record(202, [A], [], { key: "k", verdict: "ok", at: 2 }),
			record(424, [A], [], { key: "j", verdict: "ok", at: 1 }),
		]);
		expect(
			loadRecords(dir)
				.map((r) => `${r.key}:${r.verdict}`)
				.sort(),
		).toEqual(["j:ok", "k:ok"]);
	});
});

describe("judgeCensus", () => {
	const A = "tests/a.test.ts";
	const B = "tests/b.test.ts";
	const listed = [entry(A, 202, "t1")];
	const fullRecords = (extra: CensusRecord[] = []) => [
		record(202, [A, B], [member(A, "t1")]),
		confirm(202, A, [member(A, "t1")]),
		...extra,
	];

	it("is clean when every confirmed member is in the ratchet", () => {
		const verdict = judgeCensus({ records: fullRecords(), ratchet: listed });
		expect(verdict.code).toBe(0);
		expect(verdict.lines.join("\n")).toContain(
			"1 member(s), all in the ratchet",
		);
	});

	// Recurrence (the acceptance row "a new member reds"): a test that turns
	// order-dependent after this PR lands must red the census, not slip in
	// beside the listed ones.
	it("reds a confirmed member the ratchet does not list", () => {
		const verdict = judgeCensus({
			records: fullRecords([
				record(424, [B], [member(B, "t9", "Error: late")]),
				confirm(424, B, [member(B, "t9")]),
			]),
			ratchet: listed,
		});
		expect(verdict.code).toBe(1);
		expect(verdict.lines).toContain(
			"new order-dependent member: 424|tests/b.test.ts|t9 (Error: late)",
		);
	});

	// Recurrence (the acceptance row "a removed member must leave the list"):
	// a fixed member left in the list lets it come back unseen, so the list
	// would stop shrinking.
	it("reds a ratchet entry whose file ran and no longer reproduces", () => {
		const verdict = judgeCensus({
			records: [record(202, [A, B], []), confirm(202, A, [])],
			ratchet: listed,
		});
		expect(verdict.code).toBe(1);
		expect(verdict.lines).toContain(
			"ratchet entry no longer reproduces, delete it: 202|tests/a.test.ts|t1",
		);
	});

	// Recurrence: judging a half-finished pass as if it were complete reds
	// every entry whose start simply has not run yet.
	it("does not call a ratchet entry stale while its start has not run", () => {
		const verdict = judgeCensus({
			records: [record(424, [B], [])],
			ratchet: listed,
		});
		expect(verdict.lines.join("\n")).not.toContain("no longer reproduces");
		expect(verdict.code).toBe(0);
	});

	// Recurrence: a chunk start can red from the load of its 24 neighbours;
	// counting it without the alone re-run put load flakes in the ratchet.
	it("leaves a member out when its file alone under the seed is green", () => {
		const verdict = judgeCensus({
			records: [record(202, [A, B], [member(A, "t1")]), confirm(202, A, [])],
			ratchet: [],
		});
		expect(verdict.members).toEqual([]);
		expect(verdict.code).toBe(0);
		expect(verdict.lines.join("\n")).toContain("not reproducible alone");
	});

	// Recurrence: judging before the confirm pass ran would pass a load flake
	// or red a real member as "new"; it is unproven until confirmed.
	it("is unproven (3), not clean, while a shuffled member is unconfirmed", () => {
		const verdict = judgeCensus({
			records: [record(202, [A, B], [member(A, "t1")])],
			ratchet: listed,
		});
		expect(verdict.code).toBe(3);
		expect(verdict.lines).toContain(
			"not confirmed yet: 202|tests/a.test.ts|t1",
		);
	});

	// Recurrence: a file that fails alone fails under every seed; listing it
	// four times (alone plus 3 seeds) is noise the fixer must clear four times.
	it("counts a test that fails alone once, as the alone member", () => {
		const verdict = judgeCensus({
			records: [
				record("alone", [A], [member(A, "t1")]),
				record(202, [A, B], [member(A, "t1")]),
				confirm(202, A, [member(A, "t1")]),
			],
			ratchet: [],
		});
		expect(verdict.members.map((m) => `${m.seed}|${m.test}`)).toEqual([
			"alone|t1",
		]);
	});

	// Recurrence: an alone start has no order; labelling a host-environment red
	// (the formatter tests on a host without the formatters) "order-dependent"
	// sends the fixer to hunt a sibling that does not exist.
	it("labels a member that fails alone as failing alone", () => {
		const verdict = judgeCensus({
			records: [record("alone", [A], [member(A, "t1", "Error: no oxfmt")])],
			ratchet: [],
		});
		expect(verdict.code).toBe(1);
		expect(verdict.lines).toEqual([
			"fails alone: alone|tests/a.test.ts|t1 (Error: no oxfmt)",
		]);
	});

	// Recurrence: a hung or uncollected start proves nothing about its files.
	it("is unproven when a start timed out or was never collected", () => {
		for (const verdict of ["timeout", "uncollected"] as const) {
			const result = judgeCensus({
				records: [record(202, [A], [], { verdict })],
				ratchet: [],
			});
			expect(result.code).toBe(3);
		}
	});

	// Recurrence: a red start with no parsable failing test (a worker crash)
	// read as green would hide the very crash it exists to find.
	it("is unproven when a start is red and names no failing test", () => {
		const result = judgeCensus({
			records: [record(202, [A], [], { verdict: "red" })],
			ratchet: [],
		});
		expect(result.code).toBe(3);
	});
});

describe("run (report and arguments)", () => {
	// Recurrence: the exit code is what a nightly job reads; a report that
	// prints the members but exits 0 turns the ratchet into a log line.
	it("--report exits 1 for a member beyond the ratchet and 0 once it is listed", () => {
		const dir = scratchDir("report");
		const out = path.join(dir, "out");
		fs.mkdirSync(out);
		const A = "tests/a.test.ts";
		fs.writeFileSync(
			path.join(out, "census.0-of-1.jsonl"),
			`${[
				record(202, [A], [member(A, "t1")]),
				confirm(202, A, [member(A, "t1")]),
			]
				.map((r) => JSON.stringify(r))
				.join("\n")}\n`,
		);
		fs.writeFileSync(path.join(dir, "ratchet.json"), '{"members":[]}');
		const lines: string[] = [];
		const args = [
			"--out",
			out,
			"--report",
			"--cwd",
			dir,
			"--ratchet",
			"ratchet.json",
		];
		expect(run(args, { log: (line) => lines.push(line) })).toBe(1);
		expect(lines.join("\n")).toContain(
			"new order-dependent member: 202|tests/a.test.ts|t1",
		);
		fs.writeFileSync(
			path.join(dir, "ratchet.json"),
			JSON.stringify({ members: [entry(A, 202, "t1")] }),
		);
		expect(run(args, { log: quiet })).toBe(0);
	});

	// Recurrence: `--part 3/3` would select no start and report a clean census.
	it("rejects a part index outside k/n and a missing --out", () => {
		expect(() => parseArgs(["--out", ".", "--part", "3/3"])).toThrow(/k < n/);
		expect(() => parseArgs(["--part", "0/3"])).toThrow(/--out is required/);
		expect(parseArgs(["--out", ".", "--part", "2/3"]).part).toEqual([2, 3]);
	});
});

describe("the ratchet file", () => {
	const ROOT = path.resolve(import.meta.dirname, "../..");
	const parsed = JSON.parse(
		fs.readFileSync(
			path.join(ROOT, "scripts/shuffle-census-ratchet.json"),
			"utf8",
		),
	) as { members: RatchetEntry[] };
	const SEAMS = new Set([
		"declaration-order",
		"index-activation-state",
		"lsp-real-server-timing",
		"module-latch-singleton",
		"once-per-session-sink",
		"persisted-graph-store",
		"tree-sitter-wasm-state",
	]);
	// The ratchet's size, pinned both ways: adding a member raises it (a
	// reviewer sees a new order-dependent test admitted), fixing one lowers it.
	// Lower this number in the PR that fixes a member; never raise it to admit
	// a new one without a named seam and an issue.
	const PINNED_MEMBERS = 62;

	// Recurrence: a ratchet that grows silently (the point of #4405 is that it
	// can only shrink).
	it("holds exactly the pinned number of members", () => {
		expect(parsed.members).toHaveLength(PINNED_MEMBERS);
	});

	// Recurrence: an entry for a deleted or renamed file can never reproduce, so
	// the census would red "delete it" on every pass.
	it("names only existing test files, known seeds and a seam, once each", () => {
		const seen = new Set<string>();
		for (const item of parsed.members) {
			expect(fs.existsSync(path.join(ROOT, item.file)), item.file).toBe(true);
			expect(CENSUS_SEEDS, `${item.file} seed`).toContain(item.seed);
			expect(item.test.length, `${item.file} test`).toBeGreaterThan(0);
			expect(SEAMS.has(item.seam), `${item.file} seam ${item.seam}`).toBe(true);
			const key = `${item.seed}|${item.file}|${item.test}`;
			expect(seen.has(key), `duplicate ${key}`).toBe(false);
			seen.add(key);
		}
	});

	// Recurrence: the files this PR fixed must not come back as ratchet entries
	// (a copied-in stale list would hide a re-break behind an admission).
	it("does not list the files fixed at their cause", () => {
		const listedFiles = new Set(parsed.members.map((item) => item.file));
		expect(listedFiles.has("tests/index-integration.test.ts")).toBe(false);
		expect(
			listedFiles.has(
				"tests/clients/dispatch/runners/tree-sitter-runner.test.ts",
			),
		).toBe(false);
	});
});
