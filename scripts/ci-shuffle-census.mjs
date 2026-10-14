#!/usr/bin/env node
/**
 * scripts/ci-shuffle-census.mjs (#4405)
 *
 *   node scripts/ci-shuffle-census.mjs --out <dir> [--part k/n] [--chunk 25]
 *       [--budget-ms N] [--seeds 202,424,606] [--files a.test.ts,b.test.ts]
 *   node scripts/ci-shuffle-census.mjs --out <dir> --confirm [--part k/n] [--budget-ms N]
 *   node scripts/ci-shuffle-census.mjs --out <dir> --report [--ratchet <file>]
 *
 * The whole-tree twin of `ci-shuffle-changed-tests.mjs` (#4397). That job runs
 * a PR's changed test files alone and shuffled; an order-dependent test in a
 * file no PR touches stays hidden until a later PR edits the file, and that PR
 * then pays for a defect it did not write (#4398's verify found 3 of the 44
 * files in `tests/tools/` order-dependent). The census runs every test file
 *
 *   - alone, in file order (a dependence on a sibling's side effect), and
 *   - inside shuffled chunks of CHUNK_FILES files, once per seed in
 *     CENSUS_SEEDS (a dependence on the order of cases or files),
 *
 * through the changed-files job's own planner, runner and process boundary
 * (`planRuns`, `runPlan`, `execVitest`), not a second runner. Chunks keep a
 * start inside the foreground time cap and the memory budget; a vitest fork
 * per file already isolates one file's module state from another's, so a chunk
 * is not a weaker shuffle of one file's cases.
 *
 * A full pass takes hours on a 3-worker budget, so every finished start is
 * appended to `<out>/census.<part>.jsonl` and a rerun skips what is recorded
 * (`--budget-ms` bounds one call; `--part k/n` takes every n-th start so n
 * calls with PI_LENS_TEST_MAX_WORKERS=1 spend the same three workers). A
 * member seen in a shuffled chunk is re-run with its file alone and its seed
 * (`--confirm`) before it counts: a chunk start can red from the load of its
 * neighbours, and a reproducible `vitest run <file> --sequence.seed=<seed>`
 * is what a fixer needs.
 *
 * `--report` reads the records and diffs the confirmed members against the
 * ratchet (`scripts/shuffle-census-ratchet.json`): a member the ratchet does
 * not list is a new order-dependent test (exit 1), a ratchet entry the census
 * no longer finds is a fixed one the list must drop (exit 1, so the list only
 * shrinks), a start that did not finish leaves the verdict unproven (exit 3).
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import {
	execVitest,
	planRuns,
	reproCommand,
	runPlan,
	SEEDS,
	selectChangedTestFiles,
} from "./ci-shuffle-changed-tests.mjs";
import {
	normalizeVitestOutput,
	parseVitestSummary,
} from "./lib/vitest-summary.mjs";

/** The changed-files job's two seeds plus one the census adds. */
export const CENSUS_SEEDS = Object.freeze([...SEEDS, 606]);
/** Files per shuffled start: 13-170 s at one worker over the tree (#4405), under the 10 min call cap. */
export const CHUNK_FILES = 25;
/** One start never gets more than this, whatever the call budget has left. */
export const START_CAP_MS = 8 * 60_000;
/** A start is not begun with less than this left: it would be cut and wasted. */
export const MIN_START_MS = 90_000;
export const RATCHET_PATH = "scripts/shuffle-census-ratchet.json";
const FILE_SENTINEL = "(file)";
const TAIL_LINES = 30;

/** Every vitest-collected test file the repo tracks. */
export function listTestFiles(cwd) {
	const listed = gitExecFileSync(["ls-files", "-z", "--", "tests"], {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return selectChangedTestFiles(listed.split("\0").filter(Boolean), (file) =>
		existsSync(path.join(cwd, file)),
	);
}

/** @param {{ flags: string[] }} run @returns {number | "alone"} */
export function seedOf(run) {
	const flag = run.flags.find((entry) => entry.startsWith("--sequence.seed="));
	return flag === undefined ? "alone" : Number(flag.split("=")[1]);
}

/**
 * Shuffled chunks per seed, then every file alone. Starts carry `kind` so a
 * confirm start never reads as a census start.
 *
 * @param {string[]} files
 * @param {{ seeds?: readonly number[], chunk?: number }} [options]
 */
export function planCensus(
	files,
	{ seeds = CENSUS_SEEDS, chunk = CHUNK_FILES } = {},
) {
	const chunks = [];
	for (let at = 0; at < files.length; at += chunk)
		chunks.push(files.slice(at, at + chunk));
	const shuffled = seeds.flatMap((seed) =>
		chunks.flatMap((part, index) =>
			planRuns(part, [seed], { alone: false }).map((entry) => ({
				...entry,
				label: `${entry.label} chunk ${index + 1}/${chunks.length}`,
				kind: "census",
			})),
		),
	);
	const alone = planRuns(files, [], { alone: true }).map((entry) => ({
		...entry,
		kind: "census",
	}));
	return [...shuffled, ...alone];
}

/**
 * The failing tests a vitest transcript names: file, test, first error line.
 * Reads the transcript through the shared parser (AGENTS.md shape 63), one
 * `FAIL` banner at a time so a long failure list is not truncated.
 *
 * @param {string} output
 * @returns {Array<{ file: string, test: string, firstError: string }>}
 */
export function extractMembers(output) {
	const lines = normalizeVitestOutput(output).split("\n");
	const seen = new Map();
	for (const [index, line] of lines.entries()) {
		if (!/^\s*FAIL\b/.test(line)) continue;
		const id = parseVitestSummary(line).failureIds[0];
		if (id === undefined) continue;
		const bare = id.replace(/^[^\s:]*::/, "");
		const split = bare.indexOf(" › ");
		const file = split < 0 ? bare : bare.slice(0, split);
		const test = split < 0 ? FILE_SENTINEL : bare.slice(split + 3);
		const key = `${file}\0${test}`;
		if (seen.has(key)) continue;
		const firstError =
			lines
				.slice(index + 1)
				.map((entry) => entry.trim())
				.find(
					(entry) =>
						entry !== "" && !/^[⎯-]+/.test(entry) && !/^FAIL\b/.test(entry),
				) ?? "";
		seen.set(key, { file, test, firstError: firstError.slice(0, 240) });
	}
	return [...seen.values()];
}

/** @param {string} dir */
export function loadRecords(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => /^census\.[\w-]+\.jsonl$/.test(name))
		.flatMap((name) =>
			readFileSync(path.join(dir, name), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		);
}

/**
 * Runs the starts this part has not recorded, one at a time, until the call
 * budget cannot cover another. A start the budget cut is not recorded: it
 * reruns whole on the next call.
 *
 * @param {ReturnType<typeof planCensus>} plan
 * @param {{
 *   cwd: string,
 *   outFile: string,
 *   done: Set<string>,
 *   budgetMs: number,
 *   exec?: typeof execVitest,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 */
export function runCensus(plan, options) {
	const {
		cwd,
		outFile,
		done,
		budgetMs,
		exec = execVitest,
		now = () => performance.now(),
		log = console.log,
	} = options;
	const started = now();
	let ran = 0;
	let pending = 0;
	for (const entry of plan) {
		const key = reproCommand(entry);
		if (done.has(key)) continue;
		const remaining = budgetMs - (now() - started);
		if (remaining < MIN_START_MS) {
			pending += 1;
			continue;
		}
		const cap = Math.min(remaining, START_CAP_MS);
		const { results } = runPlan([entry], {
			cwd,
			budgetMs: cap,
			exec,
			now,
			log: () => {},
		});
		const result = results[0];
		if (result.verdict === "timeout" && cap < START_CAP_MS) {
			pending += 1;
			continue;
		}
		const members =
			result.verdict === "red" ? extractMembers(result.output) : [];
		const record = {
			key,
			kind: entry.kind,
			label: entry.label,
			files: entry.files,
			seed: seedOf(entry),
			verdict: result.verdict,
			ms: Math.round(result.ms),
			members,
			tail:
				result.verdict !== "ok" && members.length === 0
					? result.output.split("\n").slice(-TAIL_LINES).join("\n")
					: undefined,
		};
		appendFileSync(outFile, `${JSON.stringify(record)}\n`);
		done.add(key);
		ran += 1;
		log(
			`[census] ${entry.label}: ${result.verdict} (${(result.ms / 1000).toFixed(1)}s, ${members.length} member(s))`,
		);
	}
	return { ran, pending };
}

/** The `--confirm` starts: each shuffled member's file, alone, under its seed. */
export function planConfirms(records) {
	const wanted = new Map();
	for (const record of records) {
		if (record.kind !== "census" || record.seed === "alone") continue;
		for (const member of record.members)
			wanted.set(`${record.seed}\0${member.file}`, [member.file, record.seed]);
	}
	return [...wanted.values()]
		.sort((a, b) => (`${a[1]}${a[0]}` < `${b[1]}${b[0]}` ? -1 : 1))
		.flatMap(([file, seed]) =>
			planRuns([file], [seed], { alone: false }).map((entry) => ({
				...entry,
				label: `confirm ${entry.label} ${file}`,
				kind: "confirm",
			})),
		);
}

const memberKey = (member) => `${member.seed}|${member.file}|${member.test}`;

/**
 * @param {{ records: any[], ratchet: Array<{ file: string, seed: number | "alone", test: string }> }} state
 * @returns {{ code: 0 | 1 | 3, kind: "clean" | "red" | "unproven", members: any[], lines: string[] }}
 */
export function judgeCensus({ records, ratchet }) {
	const census = records.filter((record) => record.kind === "census");
	const confirms = new Map();
	for (const record of records.filter((entry) => entry.kind === "confirm"))
		confirms.set(`${record.seed}\0${record.files[0]}`, record);
	/** @type {Map<string, any>} */
	const members = new Map();
	const lines = [];
	// Members seen in a chunk and not yet re-run alone: neither a member nor a
	// fixed one, so their ratchet entry is not judged stale.
	const unconfirmed = new Set();
	let unproven = false;
	for (const record of census) {
		if (record.verdict === "timeout" || record.verdict === "uncollected") {
			lines.push(`${record.verdict}: ${record.label}`);
			unproven = true;
		} else if (record.verdict === "red" && record.members.length === 0) {
			lines.push(`red with no failing test named: ${record.label}`);
			unproven = true;
		}
		for (const member of record.members) {
			const entry = { ...member, seed: record.seed };
			if (record.seed !== "alone") {
				const confirm = confirms.get(`${record.seed}\0${member.file}`);
				if (confirm === undefined) {
					lines.push(`not confirmed yet: ${memberKey(entry)}`);
					unconfirmed.add(memberKey(entry));
					unproven = true;
					continue;
				}
				if (!confirm.members.some((other) => other.test === member.test)) {
					lines.push(
						`not reproducible alone (chunk load?): ${memberKey(entry)}`,
					);
					continue;
				}
			}
			members.set(memberKey(entry), entry);
		}
	}
	// A test that fails alone fails under every seed: one member, the alone one.
	for (const [key, entry] of members)
		if (
			entry.seed !== "alone" &&
			members.has(memberKey({ ...entry, seed: "alone" }))
		)
			members.delete(key);
	const listed = new Map(ratchet.map((entry) => [memberKey(entry), entry]));
	// A ratchet entry is stale only when its (file, seed) start finished.
	const covered = new Set();
	for (const record of census)
		if (record.verdict === "ok" || record.verdict === "red")
			for (const file of record.files) covered.add(`${record.seed}|${file}`);
	let red = false;
	for (const [key, entry] of members)
		if (!listed.has(key)) {
			// An alone start has no order to depend on: the test simply fails.
			const kind =
				entry.seed === "alone" ? "fails alone" : "new order-dependent member";
			lines.push(`${kind}: ${key} (${entry.firstError})`);
			red = true;
		}
	for (const [key, entry] of listed)
		if (
			!members.has(key) &&
			!unconfirmed.has(key) &&
			covered.has(`${entry.seed}|${entry.file}`)
		) {
			lines.push(`ratchet entry no longer reproduces, delete it: ${key}`);
			red = true;
		}
	const total = new Set(census.flatMap((record) => record.files)).size;
	if (red)
		return { code: 1, kind: "red", members: [...members.values()], lines };
	if (unproven)
		return { code: 3, kind: "unproven", members: [...members.values()], lines };
	lines.push(
		`${total} file(s), ${census.length} start(s), ${members.size} member(s), all in the ratchet`,
	);
	return { code: 0, kind: "clean", members: [...members.values()], lines };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
	const options = {
		out: null,
		part: [0, 1],
		chunk: CHUNK_FILES,
		budgetMs: 9 * 60_000,
		seeds: [...CENSUS_SEEDS],
		files: null,
		confirm: false,
		report: false,
		ratchet: RATCHET_PATH,
		cwd: process.cwd(),
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--confirm" || flag === "--report") {
			options[flag.slice(2)] = true;
			continue;
		}
		const value = argv[++index];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		if (flag === "--out") options.out = path.resolve(value);
		else if (flag === "--part") {
			const match = /^(\d+)\/(\d+)$/.exec(value);
			if (!match || Number(match[1]) >= Number(match[2]))
				throw new Error(`--part wants k/n with k < n: ${value}`);
			options.part = [Number(match[1]), Number(match[2])];
		} else if (flag === "--chunk") options.chunk = Number(value);
		else if (flag === "--budget-ms") options.budgetMs = Number(value);
		else if (flag === "--seeds") options.seeds = value.split(",").map(Number);
		else if (flag === "--files")
			options.files = value.split(",").filter(Boolean);
		else if (flag === "--ratchet") options.ratchet = value;
		else if (flag === "--cwd") options.cwd = path.resolve(value);
		else throw new Error(`unknown argument ${flag}`);
	}
	if (options.out === null) throw new Error("--out is required");
	if (
		!(options.chunk >= 1) ||
		!(options.budgetMs > 0) ||
		options.seeds.some((seed) => !Number.isInteger(seed))
	)
		throw new Error(
			"--chunk, --budget-ms and --seeds must be positive numbers",
		);
	return options;
}

/**
 * @param {string[]} argv
 * @param {{ exec?: typeof execVitest, now?: () => number, log?: (line: string) => void }} [io]
 * @returns {number} exit code
 */
export function run(argv, io = {}) {
	const { exec, now, log = console.log } = io;
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	mkdirSync(options.out, { recursive: true });
	if (options.report) {
		const ratchetFile = path.resolve(options.cwd, options.ratchet);
		const ratchet = existsSync(ratchetFile)
			? JSON.parse(readFileSync(ratchetFile, "utf8")).members
			: [];
		const verdict = judgeCensus({ records: loadRecords(options.out), ratchet });
		for (const member of verdict.members)
			log(
				`[census] member | ${member.file} | seed ${member.seed} | ${member.test} | ${member.firstError}`,
			);
		for (const line of verdict.lines) log(`[census] ${line}`);
		log(`shuffle-census: exit ${verdict.code} (${verdict.kind})`);
		return verdict.code;
	}
	const [part, parts] = options.part;
	const mine = (plan) => plan.filter((_, index) => index % parts === part);
	const records = loadRecords(options.out);
	const plan = options.confirm
		? planConfirms(records)
		: planCensus(options.files ?? listTestFiles(options.cwd), {
				seeds: options.seeds,
				chunk: options.chunk,
			});
	const done = new Set(records.map((record) => record.key));
	const { ran, pending } = runCensus(mine(plan), {
		cwd: options.cwd,
		outFile: path.join(options.out, `census.${part}-of-${parts}.jsonl`),
		done,
		budgetMs: options.budgetMs,
		exec,
		now,
		log,
	});
	log(
		`[census] part ${part}/${parts}: ${ran} start(s) this call, ${pending} still to run`,
	);
	return pending > 0 ? 3 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exitCode = run(process.argv.slice(2));
