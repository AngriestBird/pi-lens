/**
 * #884 — tree-sitter rules whose queries never compiled (silently dead since
 * authoring). Each rule below had a query that failed to compile against the
 * real grammar (wrong node/field names, an invalid inline regex flag, or an
 * unimplemented post_filter). These tests pin the repaired rules end-to-end:
 * every one must match a minimal snippet embodying the bug it hunts and leave a
 * nearby correct snippet alone.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

function writeTempFile(ext: string, contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-884-"));
	tmpDirs.push(dir);
	const filePath = path.join(dir, `sample.${ext}`);
	fs.writeFileSync(filePath, contents, "utf-8");
	return filePath;
}

async function getQuery(id: string) {
	const loader = new TreeSitterQueryLoader();
	const queries = await loader.loadQueries(process.cwd());
	for (const langQueries of queries.values()) {
		const found = langQueries.find((q) => q.id === id);
		if (found) return found;
	}
	throw new Error(`missing query ${id}`);
}

async function count(id: string, ext: string, lang: string, src: string) {
	const client = getSharedTreeSitterClient()!;
	const query = await getQuery(id);
	const file = writeTempFile(ext, src);
	return (await client.runQueryOnFile(query, file, lang)).length;
}

afterAll(() => {
	for (const dir of tmpDirs) removeTempDirSync(dir);
});

describe("empty-switch-case (TS)", () => {
	it("matches a case with no body", async () => {
		expect(
			await count(
				"empty-switch-case",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n case 2:\n  doWork();\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match cases that all have bodies", async () => {
		expect(
			await count(
				"empty-switch-case",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  doWork();\n  break;\n case 2:\n  other();\n  break;\n}`,
			),
		).toBe(0);
	});
});

describe("infinite-loop (TS)", () => {
	it("matches while(true) with no exit", async () => {
		expect(
			await count(
				"infinite-loop",
				"ts",
				"typescript",
				`while (true) {\n doWork();\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("matches for(;;) with no exit", async () => {
		expect(
			await count("infinite-loop", "ts", "typescript", `for (;;) {\n tick();\n}`),
		).toBeGreaterThan(0);
	});

	it("does not match while(true) that breaks", async () => {
		expect(
			await count(
				"infinite-loop",
				"ts",
				"typescript",
				`while (true) {\n if (done) break;\n doWork();\n}`,
			),
		).toBe(0);
	});

	it("does not match for(;;) that returns", async () => {
		expect(
			await count(
				"infinite-loop",
				"ts",
				"typescript",
				`for (;;) {\n return 1;\n}`,
			),
		).toBe(0);
	});
});

describe("duplicate-function-arg (TS)", () => {
	it("matches duplicate parameter names", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function add(a, a) { return a; }`,
			),
		).toBeGreaterThan(0);
	});

	it("matches non-adjacent duplicate parameters", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function f(a, b, a) { return a + b; }`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match unique parameters", async () => {
		expect(
			await count(
				"duplicate-function-arg",
				"ts",
				"typescript",
				`function add(a, b) { return a + b; }`,
			),
		).toBe(0);
	});
});

describe("mixed-async-styles (TS)", () => {
	it("matches await mixed with a .then() chain", async () => {
		expect(
			await count(
				"mixed-async-styles",
				"ts",
				"typescript",
				`async function getUser() {\n const r = await fetch("/u");\n return r.json().then((d) => d.name);\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match consistent async/await", async () => {
		expect(
			await count(
				"mixed-async-styles",
				"ts",
				"typescript",
				`async function getUser() {\n const r = await fetch("/u");\n const d = await r.json();\n return d.name;\n}`,
			),
		).toBe(0);
	});
});

describe("switch-case-termination (TS)", () => {
	it("matches a case that falls through", async () => {
		expect(
			await count(
				"switch-case-termination",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  doSomething();\n case 2:\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match cases that terminate", async () => {
		expect(
			await count(
				"switch-case-termination",
				"ts",
				"typescript",
				`switch (x) {\n case 1:\n  return "one";\n case 2:\n  break;\n}`,
			),
		).toBe(0);
	});
});

describe("ts-insecure-random (TS)", () => {
	it("matches Math.random() feeding a security-sensitive binding", async () => {
		expect(
			await count(
				"ts-insecure-random",
				"ts",
				"typescript",
				`const token = Math.random().toString(36);`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match Math.random() for a non-sensitive binding", async () => {
		expect(
			await count(
				"ts-insecure-random",
				"ts",
				"typescript",
				`const ratio = Math.random();`,
			),
		).toBe(0);
	});
});

describe("switch-case-termination-js (JS)", () => {
	it("matches a case that falls through", async () => {
		expect(
			await count(
				"switch-case-termination-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  doSomething();\n case 2:\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match cases that terminate", async () => {
		expect(
			await count(
				"switch-case-termination-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  return "one";\n case 2:\n  break;\n}`,
			),
		).toBe(0);
	});
});

describe("switch-non-case-labels-js (JS)", () => {
	it("matches a non-case label inside a switch", async () => {
		expect(
			await count(
				"switch-non-case-labels-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  break;\n case 2:\n  myLabel:\n   doSomething();\n  break;\n}`,
			),
		).toBeGreaterThan(0);
	});

	it("does not match a normal switch", async () => {
		expect(
			await count(
				"switch-non-case-labels-js",
				"js",
				"javascript",
				`switch (x) {\n case 1:\n  break;\n default:\n  break;\n}`,
			),
		).toBe(0);
	});
});
