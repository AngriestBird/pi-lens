/**
 * #4589: unrestored `process.env` writes in test source — a ratchet.
 *
 * The 2026-10-17 audit of Greptile's reviews counted the same test-hygiene
 * leak seven times (#4563, #4572, #4573, #4574, #4581, #4582, #4586): a case
 * assigns or deletes an environment variable and nothing puts it back, so the
 * NEXT case in the same worker inherits it. This sweep decides the one shape
 * that is decidable from test source. The detector lives in
 * `tests/support/test-env-restore-gate.ts`; the accepted restores are one
 * `afterEach`/`afterAll` write of the same key, `vi.stubEnv` paired with
 * `vi.unstubAllEnvs()`, or a `finally` in the same function.
 *
 * The baseline (`tests/support/test-env-restore-baseline.ts`) admits the
 * writes already leaking on master, so this lands as a ratchet instead of a
 * mass edit. Shrinking it is the work; growing it reds.
 *
 * The sweep reads comment- and string-BLANKED source (principles §2,
 * "Detectors match code, not prose"), so an env write quoted in a comment or
 * in a fixture string is not a write, and a restore quoted in one is not a
 * restore.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import {
	type EnvRestoreFinding,
	envRestoreKey,
	findUnrestoredEnvWrites,
} from "../support/test-env-restore-gate.js";
import { TEST_ENV_RESTORE_BASELINE } from "../support/test-env-restore-baseline.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const BASELINE_PATH = path.join(
	REPO_ROOT,
	"tests/support/test-env-restore-baseline.ts",
);
const BASELINE_HEADER =
	"#4589 baseline: the env writes already leaking on master, admitted so the sweep is a ratchet, not a mass edit.";
/** Baseline for the live tree, as a Set so the two directions are symmetric. */
const BASELINE: ReadonlySet<string> = new Set(TEST_ENV_RESTORE_BASELINE);

/**
 * `tests/fixtures/**` is out of the population: a fixture entry script runs in
 * its own child process, so the env it writes dies with that process and no
 * sibling case can inherit it.
 */
const OUT_OF_POPULATION = "fixtures/";

/**
 * Every env write in test source that no accepted restore covers.
 *
 * The walk reads one file at a time and turns the event loop between files,
 * the shape the sibling `vi-mock-export-sweep` uses (#3565), so a big
 * population cannot pin every file's text at once inside one case budget.
 */
function detectAcrossFiles(files: string[]): EnvRestoreFinding[] {
	const findings: EnvRestoreFinding[] = [];
	for (const { file, source } of readWalkedFiles(files)) {
		// Repo-relative, so a baseline row survives a lane's absolute path.
		findings.push(
			...findUnrestoredEnvWrites(relativePosix(REPO_ROOT, file), source),
		);
	}
	return findings;
}

let sweepPromise: EnvRestoreFinding[] | undefined;

function sweepOnce(): EnvRestoreFinding[] {
	if (sweepPromise) return sweepPromise;
	const files = listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith(OUT_OF_POPULATION),
	});
	// Floor 1,400 against the ~1,590 non-fixture `tests/**/*.ts` at authoring
	// time: low enough that ordinary file churn never trips it, high enough
	// that a silently dropped directory does (shape 10).
	assertNonEmptyScan("#4589 test-env-restore sweep", files.length, 1400);
	sweepPromise = detectAcrossFiles(files);
	return sweepPromise;
}

/** Baseline rows the live tree no longer reports, so the list only shrinks. */
function staleBaselineRows(
	findings: readonly EnvRestoreFinding[],
	baseline: ReadonlySet<string>,
): string[] {
	const live = new Set(findings.map(envRestoreKey));
	return [...baseline].filter((entry) => !live.has(entry)).sort();
}

function formatFinding(finding: EnvRestoreFinding): string {
	return `${envRestoreKey(finding)} (${finding.kind} at line ${finding.line})`;
}

/**
 * Keys the live tree reports that the baseline does not admit. One red per
 * distinct `file:key` row: a second write of an admitted key in the same file
 * is the same decision, not a new offender.
 */
function unadmittedOffenders(
	findings: readonly EnvRestoreFinding[],
	baseline: ReadonlySet<string>,
): string[] {
	const reported = new Map<string, EnvRestoreFinding>();
	for (const finding of findings) {
		const entry = envRestoreKey(finding);
		if (baseline.has(entry) || reported.has(entry)) continue;
		reported.set(entry, finding);
	}
	return [...reported.values()].map(formatFinding);
}

describe("#4589 test-env-restore detector — the shapes that must red and green", () => {
	const detect = (source: string) =>
		findUnrestoredEnvWrites("tests/config/case.test.ts", source);

	it("reds on an env write with no restore anywhere (#4563)", () => {
		expect(
			detect(
				[
					'import { it } from "vitest";',
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_HOME", kind: "assign", line: 3 }]);
	});

	it("greens when an afterEach deletes the same key (#4563)", () => {
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					"afterEach(() => {",
					"\tdelete process.env.PI_LENS_HOME;",
					"});",
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("greens when an afterEach restores the saved value", () => {
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					"const saved = process.env.PILENS_DATA_DIR;",
					"afterEach(() => {",
					"\tprocess.env.PILENS_DATA_DIR = saved;",
					"});",
					'it("a case", () => {',
					'\tprocess.env.PILENS_DATA_DIR = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("still reds when the only restore is in a comment or a string", () => {
		// §2, "Detectors match code, not prose": a restore QUOTED in the file
		// is not a restore, or every offending file could green itself with a
		// comment.
		expect(
			detect(
				[
					'import { it } from "vitest";',
					"// afterEach(() => { delete process.env.PI_LENS_HOME; });",
					'const reminder = "afterEach(() => delete process.env.PI_LENS_HOME)";',
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_HOME", kind: "assign" }]);
	});

	it("reds on a write quoted only inside a fixture string", () => {
		// The other half of the same rule: a test that STORES a leaking
		// assignment in a fixture string writes nothing.
		expect(
			detect(
				[
					"const fixture = [",
					"\t'process.env.PI_LENS_HOME = \"/tmp/leak\";',",
					'].join("\\n");',
				].join("\n"),
			),
		).toEqual([]);
	});

	it("greens on vi.stubEnv paired with vi.unstubAllEnvs (#4572)", () => {
		expect(
			detect(
				[
					'import { afterEach, it, vi } from "vitest";',
					"afterEach(() => {",
					"\tvi.unstubAllEnvs();",
					"});",
					'it("a case", () => {',
					'\tvi.stubEnv("GITHUB_TOKEN", "test-token");',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reds on vi.stubEnv with no unstubAllEnvs (#4572)", () => {
		expect(
			detect(
				[
					'import { it, vi } from "vitest";',
					'it("a case", () => {',
					'\tvi.stubEnv("GITHUB_TOKEN", "test-token");',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "GITHUB_TOKEN", kind: "stub" }]);
	});

	it("greens on a teardown key-list loop", () => {
		// The dominant live idiom: keys held in one array and put back in a
		// loop. Restoring through the loop IS restoring the same key.
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					'const ENV_KEYS = ["PI_LENS_HOME", "PILENS_DATA_DIR"] as const;',
					"afterEach(() => {",
					"\tfor (const key of ENV_KEYS) delete process.env[key];",
					"});",
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reds on a key-list array the teardown only READS", () => {
		// A list is not a restore: the loop has to write through its variable.
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					'const ENV_KEYS = ["PI_LENS_HOME"] as const;',
					"afterEach(() => {",
					"\texpect(ENV_KEYS.length).toBe(1);",
					"});",
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_HOME" }]);
	});

	it("greens on a teardown helper call that names the key and its value", () => {
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					"afterEach(() => {",
					'\trestore("PI_LENS_HOME", savedHome);',
					"});",
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reds on a teardown call that only names the key", () => {
		// `log("PI_LENS_HOME")` reads the key; a restore carries the value to
		// put back. The second argument is the discriminator, so deleting it
		// must red.
		expect(
			detect(
				[
					'import { afterEach, it } from "vitest";',
					"afterEach(() => {",
					'\tnote("PI_LENS_HOME");',
					"});",
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
				].join("\n"),
			),
		).toMatchObject([{ key: "PI_LENS_HOME" }]);
	});

	it("greens on a finally in the same function (#4573)", () => {
		expect(
			detect(
				[
					'import { it } from "vitest";',
					'it("a case", async () => {',
					"\ttry {",
					'\t\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"\t} finally {",
					"\t\tdelete process.env.PI_LENS_HOME;",
					"\t}",
					"});",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reds on a finally in a different function (#4573)", () => {
		// A restore in SOME function is not a restore of this write: the two
		// cases run under different owners.
		expect(
			detect(
				[
					'import { it } from "vitest";',
					'it("a case", () => {',
					'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
					"});",
					'it("another case", async () => {',
					"\ttry {",
					'\t\tprocess.env.PI_LENS_PROBE = "1";',
					"\t} finally {",
					"\t\tdelete process.env.PI_LENS_HOME;",
					"\t}",
					"});",
				].join("\n"),
			),
		).toMatchObject([
			{ key: "PI_LENS_HOME", kind: "assign", line: 3 },
			{ key: "PI_LENS_PROBE", kind: "assign", line: 7 },
		]);
	});

	it("names a computed key by its expression, not by its line", () => {
		expect(
			detect(
				[
					'import { it } from "vitest";',
					'it("a case", () => {',
					'\tprocess.env["PI_LENS_" + "HOME"] = "/tmp/leak";',
					'\tprocess.env[ENV_REVIEW_GRAPH_MAX] = "3";',
					"});",
				].join("\n"),
			),
		).toMatchObject([
			{ key: '["PI_LENS_" + "HOME"]' },
			{ key: "ENV_REVIEW_GRAPH_MAX" },
		]);
	});

	it("reds when a baseline row vanishes from the tree", () => {
		const live = detect(
			[
				'import { it } from "vitest";',
				'it("a case", () => {',
				'\tprocess.env.PI_LENS_HOME = "/tmp/leak";',
				"});",
			].join("\n"),
		);
		expect(
			staleBaselineRows(
				live,
				new Set(["tests/config/case.test.ts:PI_LENS_HOME"]),
			),
		).toEqual([]);
		expect(
			staleBaselineRows(
				live,
				new Set([
					"tests/config/case.test.ts:PI_LENS_HOME",
					"tests/config/gone.test.ts:PI_LENS_HOME",
				]),
			),
		).toEqual(["tests/config/gone.test.ts:PI_LENS_HOME"]);
	});
});

describe("#4589 test-env-restore ratchet", () => {
	// The shared walk reads ~1,590 files once; give it its own budget so test
	// order cannot move the cost into a 60 s case (the #4549 shape).
	beforeAll(() => sweepOnce(), 120_000);

	it("reports every unrestored env write and reds on a new one", () => {
		const findings = sweepOnce();
		const problems = unadmittedOffenders(findings, BASELINE);
		process.stderr.write(
			`test-env-restore-sweep: ${findings.length} live write(s), ${BASELINE.size} baselined, ${problems.length} new\n`,
		);
		expect(problems, problems.join("\n")).toEqual([]);
	}, 60_000);

	it("baseline entries remain live", () => {
		// The shrink-only direction: a restore added anywhere makes its row
		// stale, and a stale row reds until it is deleted.
		expect(staleBaselineRows(sweepOnce(), BASELINE)).toEqual([]);
	}, 60_000);

	it.skipIf(!process.env.TEST_ENV_RESTORE_REGEN)(
		"regenerates the baseline",
		() => {
			const rows = [...new Set(sweepOnce().map(envRestoreKey))].sort();
			fs.writeFileSync(
				BASELINE_PATH,
				[
					"/**",
					` * ${BASELINE_HEADER}`,
					" */",
					"",
					"export const TEST_ENV_RESTORE_BASELINE: readonly string[] = [",
					...rows.map((row) => `\t${JSON.stringify(row)},`),
					"];",
					"",
				].join("\n"),
			);
		},
		60_000,
	);
});

describe("#4589 test-env-restore admission guard", () => {
	it("keeps the baseline a list of file:key rows", () => {
		// A row that cannot name a file and a key would admit everything under
		// that file, or nothing at all; the ratchet's identity is `file:key`.
		const malformed = TEST_ENV_RESTORE_BASELINE.filter(
			(row) => !/^tests\/[\w./-]+\.ts:[^\s]+$/.test(row),
		);
		expect(malformed).toEqual([]);
		expect(new Set(TEST_ENV_RESTORE_BASELINE).size).toBe(
			TEST_ENV_RESTORE_BASELINE.length,
		);
		expect(
			fs.readFileSync(BASELINE_PATH, "utf8").includes(BASELINE_HEADER),
		).toBe(true);
	});

	it("keeps every baseline row inside the swept population", () => {
		// A row for a path the walk never visits can never go stale, so it
		// would sit in the list forever.
		const outside = TEST_ENV_RESTORE_BASELINE.filter((row) =>
			row.startsWith(`tests/${OUT_OF_POPULATION}`),
		);
		expect(outside).toEqual([]);
		expect(
			relativePosix(REPO_ROOT, path.join(REPO_ROOT, "tests/config/x.test.ts")),
		).toBe("tests/config/x.test.ts");
	});
});
