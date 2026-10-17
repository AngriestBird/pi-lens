import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	lintPrBody,
	lintLocalPrBody,
	lintPullRequestEvent,
	testCorpus,
} from "../../scripts/check-pr-body.mjs";

const fixture = (pr: number, kind: string) =>
	readFileSync(
		new URL(`../fixtures/pr-body-compliance/${pr}.${kind}`, import.meta.url),
		"utf8",
	);
const corpus = testCorpus({ workingTree: true });
const errors = (body: string, diff: string, headFiles?: Map<string, string>) =>
	lintPrBody(body, {
		diff,
		headFiles,
		testCorpus: corpus,
		git: () => {
			throw new Error("uncaptured historical file");
		},
	}).errors.filter((row: string) => row.startsWith("PR body compliance"));
const image = (file: string, source: string) => ({
	diff: `diff --git a/${file} b/${file}\n@@ -0,0 +1,${source.split("\n").length} @@\n${source
		.split("\n")
		.map((row) => `+${row}`)
		.join("\n")}`,
	headFiles: new Map([[file, source]]),
});

afterEach(() => vi.unstubAllEnvs());

describe("diff-keyed compliance (#4585)", () => {
	it("requires each new test's red or reasoned control (#4577 row 1)", () => {
		expect(
			errors(
				fixture(4577, "body.txt"),
				fixture(4577, "diff"),
				new Map(Object.entries(JSON.parse(fixture(4577, "sources.json")))),
			).some((row) => row.includes("row 1")),
		).toBe(true);
	}, 30_000);
	it("requires a file-scoped mutation transcript (#4575 row 2)", () => {
		expect(
			errors(
				fixture(4575, "body.txt"),
				fixture(4575, "diff"),
				new Map(Object.entries(JSON.parse(fixture(4575, "sources.json")))),
			).some((row) => row.includes("row 2")),
		).toBe(true);
	});
	it("requires Windows evidence rather than a pending promise (#4566 row 4)", () => {
		expect(
			errors(
				fixture(4566, "body.txt"),
				fixture(4566, "diff"),
				new Map(Object.entries(JSON.parse(fixture(4566, "sources.json")))),
			).some((row) => row.includes("row 4")),
		).toBe(true);
	});
	it("accepts quoted red and named control, ignoring prose lookalikes", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			`it(\n"fails for stale bytes", () => {});\ntest.only("fresh control", () => {});\n// it("comment", () => {});`,
		);
		const body =
			"Control: `fresh control` — proves fresh bytes still pass.\n\n```text\nFAIL tests/a.test.ts > fails for stale bytes\nTests 1 failed\n```";
		expect(errors(body, diff, headFiles)).toEqual([]);
		expect(
			errors(
				body.replace(
					"Tests 1 failed",
					"Expected: <!-- literal\nTests 1 failed",
				),
				diff,
				headFiles,
			),
		).toEqual([]);
		expect(
			errors(`<!--\n${body}\n-->`, diff, headFiles).some((row) =>
				row.includes("fails for stale bytes"),
			),
		).toBe(true);
		expect(
			errors(body.replace("```text", "```typescript"), diff, headFiles).join(),
		).toContain("fails for stale bytes");
		expect(
			errors(
				body
					.replace("Tests 1 failed", "Tests 1 passed")
					.replace("FAIL", "PASS"),
				diff,
				headFiles,
			).join(),
		).toContain("fails for stale bytes");
	});
	it("accepts a bare fence around a real transcript (#4585 bare fence)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'test("bare fence case", () => {});',
		);
		const body = [
			"```",
			" FAIL  |default| tests/a.test.ts > bare fence case",
			"AssertionError: expected true to be false",
			"```",
		].join("\n");
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("accepts a bare vitest failure list as the red (#4585 glyph red)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'test("glyph case", () => {});',
		);
		const body = [
			"```text",
			" × glyph case 807ms",
			" × another known red 9ms",
			"```",
		].join("\n");
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("accepts a failing count whose titles sit outside the fence (#4585 count red)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'test("count case", () => {});',
		);
		const body = [
			"```text",
			" Test Files  1 failed (1)",
			"      Tests  1 failed | 2 passed (3)",
			" ❯ tests/a.test.ts > count case",
			"```",
		].join("\n");
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("keeps a later transcript below a literal opener inside a fence (#4585 fence opener)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'test("after opener case", () => {});',
		);
		const body = [
			"```text",
			"Expected: <!-- literal",
			"an earlier run with no red",
			"```",
			"",
			"```text",
			"FAIL tests/a.test.ts > after opener case",
			"Tests 1 failed",
			"```",
		].join("\n");
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("keeps evidence below an opener quoted in an inline code span (#4585 quoted opener)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'test("quoted opener case", () => {});',
		);
		const body = [
			"| shape | result |",
			"| --- | --- |",
			"| `<!-- a (no end, to EOF)` | blanked |",
			"",
			"```text",
			"FAIL tests/a.test.ts > quoted opener case",
			"Tests 1 failed",
			"```",
		].join("\n");
		expect(errors(body, diff, headFiles)).toEqual([]);
	});
	it("refuses hidden evidence and unreadable or mismatched post-images", () => {
		const { diff, headFiles } = image(
			"clients/path-utils.ts",
			"if (ready) return value;",
		);
		expect(
			errors(
				"<!-- Windows: cannot differ because pure text. -->",
				diff,
				headFiles,
			).join(),
		).toContain("row 4");
		expect(errors("", diff, new Map()).join()).toContain("post-image");
		expect(
			errors("", diff, new Map([["clients/path-utils.ts", "other"]])).join(),
		).toContain("post-image");
	});
	it("refuses a test opener whose post-image cannot be read (#4585 unknown title)", () => {
		const diff = [
			"diff --git a/tests/a.test.ts b/tests/a.test.ts",
			"@@ -0,0 +1,1 @@",
			'+it("unknown case", () => {});',
		].join("\n");
		expect(errors("", diff, new Map()).join()).toContain("post-image");
	});
	it("requires mutation file rows with red output and Windows reasons", () => {
		const { diff, headFiles } = image(
			"clients/path-utils.ts",
			'if (ready) return value;\n// if (ignored) {}\nconst prose = "catch filter";',
		);
		const body =
			"## Mutations\n| File | Mutation | Transcript |\n|---|---|---|\n| `clients/path-utils.ts` | remove ready guard | M1 |\n\n```text\nM1 clients/path-utils.ts\nFAIL tests/a.test.ts > broken guard\nTests 1 failed\n```\n\nWindows: cannot differ because this guard compares booleans without filesystem calls.";
		expect(errors(body, diff, headFiles)).toEqual([]);
		expect(
			errors(
				body.replaceAll("clients/path-utils.ts", "clients/other.ts"),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
	});
	it("finds aliases, indirect calls and titles reached through bindings", () => {
		for (const source of [
			'import { it as check } from "vitest"; check("alias case", () => {});',
			'(0, test)("indirect case", () => {});',
			'const check = it; const title = "bound case"; check(title, () => {});',
		]) {
			const { diff, headFiles } = image("tests/a.test.ts", source);
			expect(errors("", diff, headFiles).join()).toContain("row 1");
		}
	});
	it("accepts a Windows advisory read and refuses an empty reason", () => {
		const { diff, headFiles } = image(
			"clients/lsp/launch.ts",
			"const ready = true;",
		);
		expect(
			errors("Windows advisory lane run 123456789: passed.", diff, headFiles),
		).toEqual([]);
		expect(
			errors("Windows: cannot differ because", diff, headFiles).join(),
		).toContain("row 4");
	});
	it("ignores quoted branch words and regexp test calls (#4585 lexical control)", () => {
		const production = image(
			"clients/a.ts",
			'/* if (ready) catch {} */\nconst prose = "else throw";',
		);
		expect(errors("", production.diff, production.headFiles)).toEqual([]);
		const tests = image("tests/a.test.ts", '/pattern/.test("ordinary value");');
		expect(errors("", tests.diff, tests.headFiles)).toEqual([]);
	});
	it("finds each-table titles and refuses dynamic titles (#4585 title drift)", () => {
		for (const source of [
			'it.each([[1]])("table title", () => {});',
			"it(dynamicTitle(), () => {});",
		]) {
			const { diff, headFiles } = image("tests/a.test.ts", source);
			expect(errors("", diff, headFiles).join()).toContain("row 1");
		}
	});
	it("does not use green mutation output or an unrelated red as proof", () => {
		const { diff, headFiles } = image(
			"clients/a.ts",
			"if (ready) return value;",
		);
		const body =
			"## Mutation proof\nclients/a.ts\n\n```text\nmutation: clients/a.ts\nexit code: 1\nfailed test titles: × broken guard\nRED\n```";
		expect(errors(body, diff, headFiles)).toEqual([]);
		expect(
			errors(
				body
					.replace("exit code: 1", "exit code: 0")
					.replace("failed test titles", "passed test titles"),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
		expect(
			errors(
				body.replace("## Mutation proof", "## Red first"),
				diff,
				headFiles,
			),
		).toEqual([]);
		// The transcript names the file it proves, so a body quoting another
		// file's run owes this one's own evidence.
		expect(
			errors(
				body.replaceAll("clients/a.ts", "clients/b.ts"),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
	});
	it("accepts prose-led mutation tables and inline quoted output (#4581 dry run)", () => {
		const { diff, headFiles } = image(
			"clients/a.ts",
			"if (ready) return value;",
		);
		const body =
			"Mutations, run against `clients/a.ts`:\n\n| Mutation | Result |\n|---|---|\n| drop ready | RED `AssertionError: expected true to be false`, `Tests 1 failed` |";
		expect(errors(body, diff, headFiles)).toEqual([]);
		expect(
			errors(
				"```text\nmutation: clients/a.ts\nexit code: 1\nfailed test titles: × ready guard\nRED\n```\n\nMutation table (transcript above):\n| File | Change |\n|---|---|\n| clients/a.ts | drop ready |",
				diff,
				headFiles,
			),
		).toEqual([]);
		expect(
			errors(
				body.replace(
					"`AssertionError: expected true to be false`, `Tests 1 failed`",
					"1 failed",
				),
				diff,
				headFiles,
			).join(),
		).toContain("row 2");
	});
	it("requires Windows evidence for a deletion-only launch diff (#4585 touch contract)", () => {
		const diff =
			"diff --git a/clients/lsp/launch.ts b/clients/lsp/launch.ts\n@@ -1 +0,0 @@\n-oldCall();";
		expect(errors("", diff, new Map()).join()).toContain("row 4");
		expect(
			errors(
				"Windows: cannot differ because the removed declaration never runs.",
				diff,
				new Map(),
			),
		).toEqual([]);
	});
	it("requires Windows evidence at other trySpawn callers (#4566 row 4 sweep)", () => {
		const { diff, headFiles } = image(
			"clients/other-launch.ts",
			"const child = trySpawn(command);",
		);
		expect(errors("", diff, headFiles).join()).toContain("row 4");
		expect(
			errors(
				"Windows: cannot differ because the command is only inspected as text.",
				diff,
				headFiles,
			),
		).toEqual([]);
		const prose = image("clients/other-launch.ts", "// trySpawn(command)");
		expect(errors("", prose.diff, prose.headFiles)).toEqual([]);
	});
	it("accepts expanded table titles from the red transcript (#4584 dry run)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'it.each([["an empty report"]])("reds the step for %s ($5)", () => {});',
		);
		const body =
			"```text\nFAIL tests/a.test.ts > reds the step for an empty report ($5)\nTests 1 failed\n```";
		expect(errors(body, diff, headFiles)).toEqual([]);
		expect(
			errors(
				body.replace("reds the step for", "other case for"),
				diff,
				headFiles,
			).join(),
		).toContain("row 1");
	});
	it("reads a local diff under the shared byte ceiling (#4585 large diff)", () => {
		const calls: Array<[string[], unknown]> = [];
		lintLocalPrBody(
			"## Why\nOne sentence.\n",
			process.cwd(),
			(args, options) => {
				calls.push([args, options]);
				return "";
			},
		);
		// The fixture corpus makes this PR's own diff larger than a default
		// spawn buffer, and a local preflight must read the same range as CI.
		expect(calls[0][1]).toMatchObject({ maxBuffer: 16 * 1024 * 1024 });
	});
	it("refuses an unavailable local diff (#4585 fail-closed preflight)", () => {
		const body =
			"## Why\nRequire evidence before review.\n## Notes for the reviewer\nNone.\n## Change outline\n- static fixture\n## Summary\nLocal preflight contract.\n## Tests\nNo runtime edits.\n## Test assessment\nNo test edits.\n## Blast radius\nNo runtime module touched.\n## Class sweep\nnone: static fixture contains no runtime change.\n## Observability\nNo new failure path; no record added.";
		const result = lintLocalPrBody(body, process.cwd(), (args) => {
			// The base ref resolves; only the range itself cannot be read.
			if (args[0] === "rev-parse") return "deadbeef";
			throw new Error("missing upstream ref");
		});
		expect(result.valid).toBe(false);
		expect(result.errors.join()).toContain(
			"PR body compliance: diff unavailable",
		);
	});
	it("refuses an unavailable event diff outside CI (#4585 fail-closed event)", async () => {
		vi.stubEnv("GITHUB_REPOSITORY", "fixture/repo");
		vi.stubEnv("GITHUB_ACTIONS", "");
		const fetchBoundary: typeof fetch = async (url) =>
			new Response(
				JSON.stringify(
					String(url).includes("/files?") ? [] : { body: "", title: "fixture" },
				),
			);
		await expect(
			lintPullRequestEvent(
				fetchBoundary,
				{ pull_request: { number: 1, body: "" } },
				() => {
					throw new Error("missing upstream ref");
				},
			),
		).rejects.toThrow("diff unavailable");
	});
	it("requires mutation proof for ternary fallbacks (#4575 guard-shape sweep)", () => {
		const { diff, headFiles } = image(
			"clients/a.ts",
			"const answer = ready ? value : fallback;",
		);
		expect(errors("", diff, headFiles).join()).toContain("row 2");
		const typeOnly = image(
			"clients/a.ts",
			"interface Value { ready?: boolean; }",
		);
		expect(errors("", typeOnly.diff, typeOnly.headFiles)).toEqual([]);
		// A catch block is a fallback even with no `if`, `?` or `&&` in the hunk.
		const catchOnly = image(
			"clients/a.ts",
			"try { run(); } catch (error) {\n\treturn null;\n}",
		);
		expect(errors("", catchOnly.diff, catchOnly.headFiles).join()).toContain(
			"row 2",
		);
	});
	it("matches a table title's static segments in order (#4585 title order)", () => {
		const { diff, headFiles } = image(
			"tests/a.test.ts",
			'it.each([["x"]]) ("first %s last", () => {});'.replace(" ", ""),
		);
		const transcript = (title: string) =>
			[
				"```text",
				`FAIL tests/a.test.ts > ${title}`,
				"Tests 1 failed",
				"```",
			].join("\n");
		expect(errors(transcript("first x last"), diff, headFiles)).toEqual([]);
		// Reversed segments name a different title, not this declaration's
		// expansion, so they cannot vouch for it.
		expect(
			errors(transcript("last first x"), diff, headFiles).join(),
		).toContain("row 1");
	});
	it("requires mutation proof for a guard added to a shipped script (#4585 script row)", () => {
		const { diff, headFiles } = image(
			"scripts/sample.mjs",
			"if (ready) return value;",
		);
		expect(errors("", diff, headFiles).join()).toContain("row 2");
		expect(
			errors(
				"## Mutations\n| `scripts/sample.mjs` | drop ready | `Tests 1 failed` |",
				diff,
				headFiles,
			),
		).toEqual([]);
	});
	it("bounds the unclassifiable-post-image notice (#4585 notice bound)", () => {
		const files = [1, 2, 3, 4, 5, 6].map((n) => `clients/miss-${n}.ts`);
		const diff = files
			.map(
				(file) =>
					`diff --git a/${file} b/${file}\n@@ -0,0 +1 @@\n+if (ready) return value;`,
			)
			.join("\n");
		const notice = errors("", diff, new Map()).join();
		expect(notice).toContain("for 6 changed file(s)");
		expect(notice).toContain("clients/miss-5.ts (+1 more)");
	});
	it("leaves a test title the diff does not touch alone (#4585 unchanged title)", () => {
		const diff = [
			"diff --git a/tests/a.test.ts b/tests/a.test.ts",
			"@@ -1 +1,2 @@",
			' it("existing case", () => {});',
			"+// added comment",
		].join("\n");
		const headFiles = new Map([
			["tests/a.test.ts", 'it("existing case", () => {});\n// added comment'],
		]);
		expect(errors("", diff, headFiles)).toEqual([]);
	});
});
