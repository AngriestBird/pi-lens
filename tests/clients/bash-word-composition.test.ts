// flake-shape: real-process-spawn — the oracle is real `bash -c`: which directory bash enters and where its redirect lands for each generated spelling. A stubbed shell answers neither, and the rows exist because hand-written expectations kept missing spellings (#4713 rounds 8-11).
/**
 * #4713 round 11: a composition generator, run against real bash.
 *
 * Recurrence: three consecutive review rounds on one seam each found a
 * spelling the hand-written rows missed. Round 9 missed `FOO""=bar` (an empty
 * quote inside an assignment name), and round 10's fix then broke `\c""d` (an
 * escape and an empty quote inside one verb), because each round's rows gave a
 * token ONE quoting form as a whole. This file builds the spellings from the
 * product instead: for each token of a `cd` command (a prefix, the verb, the
 * operand), every internal position (start, between letters, end) crossed
 * with every quoting form that emits nothing (`''`, `""`, `$''`, `$""`,
 * backslash-newline), crossed with an escape before any letter or of the
 * separator after the token; plus one quoting form wrapped around the whole
 * token or one letter, with and without an escape inside.
 *
 * Each row runs `<spelling> ; printf x > f.ts` through real `bash -c` in a
 * fixture holding `sub/` and `sub /`, then through `scanShellWriteScopes`.
 * A row passes when the scan names the file bash wrote, or the base's answer
 * (`f.ts`, the documented fallback), AND names as a `cd` target exactly the
 * directory bash entered, or nothing when bash entered none. A row outside
 * that rule must sit in `ACCEPTED`, whose entries each carry a reason and the
 * exact number of rows they cover, so an entry that stops matching, or starts
 * matching more, reds here.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanShellWriteScopes } from "../../clients/bash-file-access.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { removeTempDirSync } from "./test-utils.js";

/** Quoting that emits no character, inserted at one position of a token. */
const EMPTY_FORMS = ["''", '""', "$''", '$""', "\\\n"] as const;
/** Quoting forms wrapped around part of a token. */
const WRAPS = [
	["'", "'"],
	['"', '"'],
	["$'", "'"],
	['$"', '"'],
] as const;

/** Every composed spelling of one token, as the header describes. */
function spellings(token: string): string[] {
	const n = token.length;
	const out = new Set<string>();
	for (let escape = -1; escape <= n; escape++) {
		const inserts: Array<readonly [number, string] | undefined> = [undefined];
		for (let at = 0; at <= n; at++)
			for (const form of EMPTY_FORMS) inserts.push([at, form]);
		for (const insert of inserts) {
			let spelled = "";
			for (let at = 0; at <= n; at++) {
				if (insert?.[0] === at) spelled += insert[1];
				if (at < n) spelled += (escape === at ? "\\" : "") + token[at];
				else if (escape === n) spelled += "\\";
			}
			out.add(spelled);
		}
	}
	const middle = Math.floor(n / 2);
	for (const [from, to] of [
		[0, n],
		[0, 1],
		[n - 1, n],
		[middle, middle + 1],
	] as const)
		for (const [open, close] of WRAPS)
			for (const escapeInside of [false, true])
				out.add(
					`${token.slice(0, from)}${open}${escapeInside ? "\\" : ""}${token.slice(from, to)}${close}${token.slice(to)}`,
				);
	return [...out];
}

interface Row {
	slot: "prefix" | "verb" | "operand";
	token: string;
	command: string;
}

const ROWS: readonly Row[] = [
	...["FOO=1", "builtin", "command"].flatMap((token) =>
		spellings(token).map((spelled): Row => ({
			slot: "prefix",
			token,
			command: `${spelled} cd sub`,
		})),
	),
	...["cd", "pushd"].flatMap((token) =>
		spellings(token).map((spelled): Row => ({
			slot: "verb",
			token,
			command: `${spelled} sub`,
		})),
	),
	...spellings("sub").map((spelled): Row => ({
		slot: "operand",
		token: "sub",
		command: `cd ${spelled}`,
	})),
];

/**
 * Accepted residuals: each names the rows it covers by predicate, why the
 * scan may differ from bash there, and how many generated rows it covers.
 */
const ACCEPTED: ReadonlyArray<{
	reason: string;
	rows: number;
	covers: (row: Row, outcome: Outcome) => boolean;
}> = [
	{
		reason:
			"R7-4, the PR's declared p3 residual: a cd whose one operand is a static path moves the scan without a stat, so a directory that does not exist (here a single-quoted backslash, `cd s'\\u'b`) is entered where bash stays",
		rows: 2,
		covers: (_row, outcome) =>
			outcome.bashEntered === undefined &&
			outcome.named.length === 1 &&
			!fs.existsSync(path.join(cwd, outcome.named[0] ?? "")),
	},
];

interface Outcome {
	bashWrote: string[];
	scanWrote: string[];
	bashEntered: string | undefined;
	named: string[];
}

let root: string;
let cwd: string;
let home: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-bwc-"));
	cwd = path.join(root, "cwd");
	home = path.join(root, "home");
	fs.mkdirSync(path.join(cwd, "sub"), { recursive: true });
	fs.mkdirSync(path.join(cwd, "sub "), { recursive: true });
	fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
	removeTempDirSync(root);
});

/** Every `f.ts` under the fixture, relative to `cwd`, removed once read. */
function takeWrites(): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === "f.ts") {
				found.push(path.relative(cwd, full));
				fs.rmSync(full);
			}
		}
	};
	walk(root);
	return found.sort();
}

function run(row: Row): Outcome {
	const command = `${row.command} ; printf x > f.ts`;
	try {
		execFileSync("bash", ["-c", command], {
			cwd,
			// A minimal environment: no CDPATH, OLDPWD or BASH_ENV, and HOME
			// inside the fixture.
			env: { PATH: process.env.PATH ?? "", HOME: home, LC_ALL: "C" },
			stdio: "ignore",
			timeout: 10_000,
		});
	} catch {
		// A row whose command bash cannot run still writes f.ts where it stood.
	}
	const bashWrote = takeWrites();
	const scan = scanShellWriteScopes(command, cwd);
	const entered =
		bashWrote.length === 1 ? path.dirname(bashWrote[0] ?? "") : undefined;
	return {
		bashWrote,
		scanWrote: scan.written.map((file) => path.relative(cwd, file)).sort(),
		bashEntered: entered === "." ? undefined : entered,
		named: scan.cdTargets.map((dir) => path.relative(cwd, dir)),
	};
}

describe.skipIf(process.platform === "win32")(
	"bash word composition against real bash (#4713 R11)",
	() => {
		it("names the file and the cd target bash does, for every composed spelling", () => {
			const failures: string[] = [];
			const covered = ACCEPTED.map(() => 0);
			let entered = 0;
			for (const row of ROWS) {
				const outcome = run(row);
				if (outcome.bashEntered !== undefined) entered++;
				const writeOk =
					outcome.scanWrote.join(",") === outcome.bashWrote.join(",") ||
					outcome.scanWrote.join(",") === "f.ts";
				const namedOk = outcome.named.join(",") === (outcome.bashEntered ?? "");
				if (writeOk && namedOk) continue;
				const accepted = ACCEPTED.findIndex((entry) =>
					entry.covers(row, outcome),
				);
				if (accepted >= 0) {
					covered[accepted] = (covered[accepted] ?? 0) + 1;
					continue;
				}
				failures.push(
					`${row.slot} ${JSON.stringify(row.command)}: bash wrote ${JSON.stringify(outcome.bashWrote)}, scan ${JSON.stringify(outcome.scanWrote)}; bash entered ${JSON.stringify(outcome.bashEntered ?? null)}, named ${JSON.stringify(outcome.named)}`,
				);
			}
			// Floors: the generator still composes, and bash still ran (a
			// missing bash would enter nothing and fail every row anyway).
			assertNonEmptyScan("composed cd spellings", ROWS.length, 1000);
			assertNonEmptyScan("spellings bash ran as a cd", entered, 100);
			expect(failures).toEqual([]);
			expect(covered).toEqual(ACCEPTED.map((entry) => entry.rows));
		}, 180_000);
	},
);
