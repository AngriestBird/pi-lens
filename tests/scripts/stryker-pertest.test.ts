// #4365: the per-test Stryker campaign's three testable halves: which tests a
// module's run is given, the vitest-5 compatibility patch to the Stryker runner,
// and the report reader that names tests which cover mutated code but kill no
// mutant. Each case names the recurrence it keeps out.
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../scripts/stryker-pertest.mjs";
import {
	findWorthlessTests,
	isGovernanceTest,
	patchVitestRunner,
	planPertest,
	summarizeReport,
} from "../../scripts/lib/stryker-pertest.mjs";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const scratch = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
};

type Mutant = {
	id: string;
	status: string;
	coveredBy?: string[];
	killedBy?: string[];
	static?: boolean;
};

// The mutation-testing-elements shape Stryker 10 writes (verified against the
// pilot report, tests/fixtures/stryker-pertest/): files[].mutants carry
// coveredBy/killedBy test ids; testFiles[].tests resolve an id to a name.
function report(
	tests: Array<[string, string]>,
	mutants: Mutant[],
): Parameters<typeof findWorthlessTests>[0] {
	return {
		files: {
			"clients/x.js": {
				mutants: mutants.map((m) => ({
					mutatorName: "ConditionalExpression",
					location: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 2 },
					},
					...m,
				})),
			},
		},
		testFiles: {
			"tests/clients/x.test.ts": {
				tests: tests.map(([id, name]) => ({ id, name })),
			},
		},
	} as never;
}

describe("findWorthlessTests (#4365)", () => {
	// Recurrence: a test whose every covered mutant is killed by a sibling reads as
	// harmless but adds nothing; the campaign exists to list exactly these.
	it("flags a test that covers mutants other tests kill, and kills none itself", () => {
		const found = findWorthlessTests(
			report(
				[
					["t0", "kills"],
					["t1", "restates"],
				],
				[
					{
						id: "0",
						status: "Killed",
						coveredBy: ["t0", "t1"],
						killedBy: ["t0"],
					},
				],
			),
		);
		expect(found).toEqual([
			expect.objectContaining({
				id: "t1",
				code: "redundant",
				covers: 1,
				kills: 0,
			}),
		]);
	});

	// Recurrence: a test that executes code whose mutants survive EVERY test
	// asserts nothing observable about that code (its own setup, a constant).
	// Recurrence (pilot, clients/run-duration.js): the one mutant every test
	// misses is covered by all of them; classifying on "covers a survivor" labelled
	// plainly redundant tests as asserting their own setup.
	it("calls a test redundant when another test kills a mutant it covers, even if it also covers a survivor", () => {
		const found = findWorthlessTests(
			report(
				[
					["t0", "kills"],
					["t1", "also runs it"],
				],
				[
					{
						id: "0",
						status: "Killed",
						coveredBy: ["t0", "t1"],
						killedBy: ["t0"],
					},
					{ id: "1", status: "Survived", coveredBy: ["t0", "t1"] },
				],
			),
		);
		expect(found).toEqual([
			expect.objectContaining({
				id: "t1",
				code: "redundant",
				survivedCovered: 1,
			}),
		]);
	});

	it("flags a test whose covered mutants all survive as observing nothing", () => {
		const found = findWorthlessTests(
			report(
				[["t0", "setup only"]],
				[{ id: "0", status: "Survived", coveredBy: ["t0"] }],
			),
		);
		expect(found).toEqual([
			expect.objectContaining({ id: "t0", code: "observes-nothing" }),
		]);
	});

	// Recurrence: a test in the related set that reaches no mutated line is not
	// evidence about this module at all.
	it("flags a test that covers no mutant as covering code no mutant reaches", () => {
		const found = findWorthlessTests(
			report(
				[
					["t0", "kills"],
					["t1", "elsewhere"],
				],
				[{ id: "0", status: "Killed", coveredBy: ["t0"], killedBy: ["t0"] }],
			),
		);
		expect(found).toEqual([
			expect.objectContaining({
				id: "t1",
				code: "covers-no-mutant",
				covers: 0,
			}),
		]);
	});

	it("never flags a test that kills a mutant", () => {
		const found = findWorthlessTests(
			report(
				[["t0", "kills"]],
				[{ id: "0", status: "Killed", coveredBy: ["t0"], killedBy: ["t0"] }],
			),
		);
		expect(found).toEqual([]);
	});

	// Recurrence: a Timeout mutant carries no killedBy, so counting it as a
	// survivor would call the test that provoked the hang worthless.
	it("does not flag a test that covers a Timeout mutant", () => {
		const found = findWorthlessTests(
			report(
				[["t0", "hangs it"]],
				[{ id: "0", status: "Timeout", coveredBy: ["t0"] }],
			),
		);
		expect(found).toEqual([]);
	});

	// Recurrence: a static mutant runs at import, so Stryker records no coveredBy;
	// reading that as "covered by nobody" would flag every test as covering nothing.
	it("treats a static mutant as covered by every test", () => {
		const found = findWorthlessTests(
			report(
				[
					["t0", "kills"],
					["t1", "passes through"],
				],
				[{ id: "0", status: "Killed", static: true, killedBy: ["t0"] }],
			),
		);
		expect(found).toEqual([
			expect.objectContaining({ id: "t1", code: "redundant", covers: 1 }),
		]);
	});

	it("resolves the test file and name for each candidate", () => {
		const [one] = findWorthlessTests(
			report(
				[["t0", "named test"]],
				[{ id: "0", status: "Survived", coveredBy: ["t0"] }],
			),
		);
		expect(one).toMatchObject({
			file: "tests/clients/x.test.ts",
			name: "named test",
		});
	});
});

describe("summarizeReport (#4365)", () => {
	it("counts mutants by status", () => {
		const counts = summarizeReport(
			report(
				[["t0", "a"]],
				[
					{ id: "0", status: "Killed", coveredBy: ["t0"], killedBy: ["t0"] },
					{ id: "1", status: "Survived", coveredBy: ["t0"] },
					{ id: "2", status: "NoCoverage" },
					{ id: "3", status: "Killed", coveredBy: ["t0"], killedBy: ["t0"] },
				],
			),
		);
		expect(counts).toMatchObject({
			total: 4,
			Killed: 2,
			Survived: 1,
			NoCoverage: 1,
		});
	});
});

describe("isGovernanceTest / planPertest (#4365)", () => {
	// Recurrence: tests/config suites read docs, workflows and manifests as text;
	// they would show up as "covers the module, kills nothing" in every run.
	it("excludes tests/config as governance", () => {
		expect(isGovernanceTest("tests/config/vitest-lane-order.test.ts")).toBe(
			true,
		);
		expect(isGovernanceTest("tests/clients/run-duration.test.ts")).toBe(false);
	});

	it("selects one-hop tests, drops governance and marker-excluded ones with a reason", () => {
		const files: Record<string, string> = {
			"tests/clients/foo.test.ts": 'import { a } from "../../clients/foo.js";',
			"tests/clients/foo-extra.test.ts":
				'import { a } from "../../clients/foo.js";',
			"tests/config/sweep.test.ts": 'import { a } from "../../clients/foo.js";',
			"tests/mcp/smoke.test.ts":
				'// mutation-lane: exclude\nimport { a } from "../../clients/foo.js";',
			"tests/clients/other.test.ts":
				'import { b } from "../../clients/bar.js";',
		};
		const plan = planPertest("clients/foo.ts", {
			testFiles: Object.keys(files),
			readFile: (f: string) => files[f],
			exclusions: { "tests/mcp/smoke.test.ts": { reason: "real stdio child" } },
		});
		expect(plan.target).toBe("clients/foo.js");
		expect(plan.tests.sort()).toEqual([
			"tests/clients/foo-extra.test.ts",
			"tests/clients/foo.test.ts",
		]);
		expect(plan.excluded).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ file: "tests/config/sweep.test.ts" }),
				expect.objectContaining({
					file: "tests/mcp/smoke.test.ts",
					reason: "real stdio child",
				}),
			]),
		);
	});

	it("refuses a module no test imports", () => {
		expect(() =>
			planPertest("clients/lonely.ts", { testFiles: [], readFile: () => "" }),
		).toThrow(/no test/i);
	});
});

describe("patchVitestRunner (#4365)", () => {
	function runnerDir(setupJoin: string, helperJoin: string): string {
		const dir = scratch("pi-lens-pertest-runner-");
		mkdirSync(join(dir, "dist", "src"), { recursive: true });
		writeFileSync(
			join(dir, "dist", "src", "stryker-setup.js"),
			`return nameParts.${setupJoin}.trim();\n`,
		);
		writeFileSync(
			join(dir, "dist", "src", "test-helpers.js"),
			`return nameParts.${helperJoin}.trim();\n`,
		);
		return dir;
	}

	// Recurrence (spike 2026-10-14): runner 10.0.0 joins describe names with a
	// space, vitest 5 matches `-t` against " > "; unpatched, every mutant run
	// skipped all tests and 16/16 mutants read "Survived".
	it("rewrites both name joins to vitest 5's separator", () => {
		const dir = runnerDir("join(' ')", "join(' ')");
		expect(patchVitestRunner(dir)).toEqual({ patched: 2 });
		for (const f of ["stryker-setup.js", "test-helpers.js"]) {
			expect(readFileSync(join(dir, "dist", "src", f), "utf8")).toContain(
				"join(' > ')",
			);
		}
	});

	it("is idempotent on an already patched runner", () => {
		const dir = runnerDir("join(' > ')", "join(' > ')");
		expect(patchVitestRunner(dir)).toEqual({ patched: 0 });
	});

	// Recurrence: a runner release that renames the join must red the campaign,
	// not silently run it unpatched and report every mutant as surviving.
	it("throws when a file holds neither the old nor the patched join", () => {
		const dir = runnerDir("join('-')", "join(' ')");
		expect(() => patchVitestRunner(dir)).toThrow(/stryker-setup\.js/);
	});
});

describe("stryker-pertest candidates command (#4365)", () => {
	// Recurrence (run 37601788256, stryker-nightly): a CLI half that read a field
	// its own subcommand never returned crashed after its files were written.
	it("writes the markdown and the JSON from a report file", () => {
		const dir = scratch("pi-lens-pertest-cli-");
		const input = join(dir, "report.json");
		writeFileSync(
			input,
			JSON.stringify(
				report(
					[["t0", "setup only"]],
					[{ id: "0", status: "Survived", coveredBy: ["t0"] }],
				),
			),
		);
		const md = join(dir, "candidates.md");
		const json = join(dir, "candidates.json");
		main([
			"candidates",
			"--report",
			input,
			"--module",
			"clients/x.ts",
			"--out",
			md,
			"--json-out",
			json,
		]);
		expect(readFileSync(md, "utf8")).toContain("setup only");
		expect(JSON.parse(readFileSync(json, "utf8")).summary).toMatchObject({
			Survived: 1,
		});
	});

	it("rejects an unknown subcommand", () => {
		expect(() => main(["nope"])).toThrow(/usage/);
	});
});
