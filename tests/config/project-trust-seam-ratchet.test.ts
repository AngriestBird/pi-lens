/**
 * #4281: in-process module doubles must use the module's real test seam.
 * Recurrence: a project-trust mock hid a newly-added export and let callers
 * exercise a second module instance instead of the process singleton.
 */

import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
} from "../support/sweep-kit.js";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import {
	createViResolver,
	mockSpecifier,
} from "../support/vi-mock-export-gate.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");

export const SEAM_MODULES = [
	{
		module: "clients/project-trust.js",
		seam: ["setProjectTrustState", "resetProjectTrust"],
	},
];

const BASELINE: Record<string, number> = {
	"clients/project-trust.js": 1,
};

/**
 * Both the hoisted `vi.mock` and the non-hoisted `vi.doMock` replace a whole
 * module, so the ratchet owns both.
 */
const MOCK_METHODS = ["mock", "doMock"] as const;

/**
 * Resolve a module specifier to its module identity: posix separators, any
 * relative depth, and a `.js`/`.ts`/extensionless spelling all name the same
 * module. Comparing the trailing `clients/<name>` path (never a raw
 * `endsWith("…js")`) keeps a nested same-named file from counting.
 */
function resolvesToModule(specifier: string, moduleName: string): boolean {
	const strip = (value: string) =>
		value.replace(/\\/g, "/").replace(/\.(?:[cm]?[jt]s)$/, "");
	const candidate = strip(specifier);
	const modulePath = strip(moduleName);
	return candidate === modulePath || candidate.endsWith(`/${modulePath}`);
}

/**
 * Whole-module mocks of `moduleName` in one test file, and every spelling the
 * scan cannot classify (#4429: a population-deriving scanner fails closed).
 *
 * The needle is every call in the AST (a comment or string quoting one is not
 * a node) that the file's {@link createViResolver} binds to vitest's utils
 * object or cannot bind. Classified: a `mock`/`doMock` call on `vi` or
 * `vitest`, under any alias, cast or `.call`/`.apply`, whose specifier
 * {@link mockSpecifier} reads (a string, a substitution-free template, or the
 * typed `import("…")` form) is counted when it resolves to the module and
 * ignored otherwise; every other bound method is not a mock. UNCLASSIFIED,
 * reported with the line: a mock call whose specifier is not readable (a
 * variable, a computed template), a utils call whose key is not a literal,
 * and a vitest module-API name (`mock`, `doMock`, `hoisted`, …) on an object
 * the resolver cannot bind. Each may mock the seam module, so it reds.
 */
function scanViMockSites(
	file: string,
	source: string,
	moduleName: string,
): { count: number; unclassified: string[] } {
	const lines = source.split("\n");
	const root = parse(Lang.TypeScript, source).root();
	const resolver = createViResolver(root);
	resolver.prime();
	const result = { count: 0, unclassified: [] as string[] };
	const report = (call: SgNode) => {
		const line = call.range().start.line + 1;
		result.unclassified.push(
			`unclassified spelling at ${file}:${line}: ${lines[line - 1]?.trim() ?? ""}`,
		);
	};
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const callee = resolver.classify(call.field("function"), MOCK_METHODS);
		if (callee.kind === "other") continue;
		if (callee.kind === "unresolved") {
			report(call);
			continue;
		}
		const args = call.field("arguments")?.namedChildren() ?? [];
		const specifierNode =
			callee.via === "direct"
				? args[0]
				: callee.via === "call"
					? args[1]
					: args[1]?.kind() === "array"
						? args[1].namedChildren()[0]
						: undefined;
		const specifier = mockSpecifier(specifierNode);
		if (specifier === undefined) report(call);
		else if (resolvesToModule(specifier, moduleName)) result.count++;
	}
	return result;
}

function countViMockSites(source: string, moduleName: string): number {
	return scanViMockSites("fixture.ts", source, moduleName).count;
}

function seamBaseName(module: string): string {
	return module.replace(/^.*\//, "").replace(/\.(?:js|ts)$/, "");
}

async function counts(): Promise<{
	counts: Record<string, number>;
	unclassified: string[];
}> {
	const files = listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith("fixtures/"),
	});
	assertNonEmptyScan("#4281 project-trust seam ratchet", files.length, 900);
	const result = Object.fromEntries(
		SEAM_MODULES.map(({ module }) => [module, 0]),
	);
	const unclassified = new Set<string>();
	for (const { file, source } of readWalkedFiles(files)) {
		// Parse only files that name a seam module: every mock spelling the
		// liveness case pins carries the module's base name as text, so the
		// substring test keeps the population exact and skips ~900 AST parses
		// (the unfiltered loop timed out in CI at 5000 ms, #4285 verify). A
		// file that mocks the module through a specifier it never spells is
		// outside this needle; the flake-shape ratchet's in-process-mock
		// detector counts every unreadable specifier in tests/ (#4429).
		const named = SEAM_MODULES.filter(({ module }) =>
			source.includes(seamBaseName(module)),
		);
		if (named.length === 0) continue;
		const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
		for (const { module } of named) {
			const scan = scanViMockSites(relative, source, module);
			result[module] += scan.count;
			for (const entry of scan.unclassified) unclassified.add(entry);
		}
		// Turn the loop between files so `@ast-grep/napi` can free each parsed
		// tree from its finalizer before the next one is built (the
		// `vi-mock-export-sweep` memory bound, #3565).
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return { counts: result, unclassified: [...unclassified] };
}

describe("project-trust real seam ratchet (#4281)", () => {
	it("keeps every seam module's whole-module mock population at or below baseline", async () => {
		const live = await counts();
		for (const { module } of SEAM_MODULES) {
			expect(live.counts[module]).toBeLessThanOrEqual(BASELINE[module]);
		}
		// Recurrence: #4411 review F3, a population scanner that skipped
		// spellings it did not recognise and passed (#4429).
		expect(live.unclassified).toEqual([]);
	});

	// Liveness: a detector that silently counts zero would pass the shrink-only
	// assertion above, so the known sites are pinned here. The comment and the
	// string literal must not count; each executable spelling must (shape 34:
	// the unlisted `doMock`/`.ts`/backtick/bracket forms are the point).
	it("detects executable mocks and ignores comments and strings", () => {
		const source = [
			'// vi.mock("../clients/project-trust.js")',
			"const text = 'vi.mock(\"../clients/project-trust.js\")';",
			'vi.mock("../clients/project-trust.js", () => ({}));',
			'vi.doMock("../clients/project-trust.js", () => ({}));',
			'vi.mock("../clients/project-trust.ts", () => ({}));',
			"vi.mock(`../clients/project-trust.js`, () => ({}));",
			'vi["mock"]("../clients/project-trust.js", () => ({}));',
			'vi.doMock("../clients/other.js", () => ({}));',
		].join("\n");
		expect(countViMockSites(source, "clients/project-trust.js")).toBe(5);
	});

	it("counts the typed import() specifier form (#4429)", () => {
		// `vi.mock(import("…"))` is vitest's typed spelling; the old reader
		// returned nothing for it, so the mock was neither counted nor reported.
		expect(
			countViMockSites(
				'vi.mock(import("../clients/project-trust.js"), () => ({}));',
				"clients/project-trust.js",
			),
		).toBe(1);
	});

	it.each([
		[
			"vitest.mock",
			'import { vitest } from "vitest";\nvitest.mock(S, () => ({}));',
		],
		[
			"an import alias",
			'import { vi as v } from "vitest";\nv.doMock(S, () => ({}));',
		],
		["a const alias", "const v = vi;\nv.doMock(S, () => ({}));"],
		["a destructured method", "const { doMock } = vi;\ndoMock(S, () => ({}));"],
		[
			"a renamed destructure",
			"const { doMock: dm } = vitest;\ndm(S, () => ({}));",
		],
		[
			"a namespace import",
			'import * as V from "vitest";\nV.vi.mock(S, () => ({}));',
		],
		["parentheses", "(vi).doMock(S, () => ({}));"],
		["a cast", "(vi as any).doMock(S, () => ({}));"],
		["a non-null assertion", "vi!.mock(S, () => ({}));"],
		[".call", "vi.doMock.call(vi, S, () => ({}));"],
		[".apply", "vi.doMock.apply(vi, [S, () => ({})]);"],
	])(
		"counts a seam mock spelled through %s (#4429 review F2)",
		(_name, body) => {
			// Recurrence: #4457 review F2, each of these mocked the seam module and
			// the `vi`-identifier needle neither counted nor reported it.
			const source = body.replaceAll("S", '"../clients/project-trust.js"');
			expect(
				scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
			).toEqual({ count: 1, unclassified: [] });
		},
	);

	it("reports a mock spelling it cannot classify, with its line (#4429)", () => {
		// The fail-closed branches: a specifier the scan cannot read, a utils
		// key it cannot read, and a module-API name on an object it cannot bind
		// (called by that name or under a rename, or held in a `let` assigned
		// later, or bound where the resolver reads no bindings) may each mock
		// the seam module, so each reds.
		const source = [
			'const target = "../clients/project-trust.js";',
			"vi.mock(target, () => ({}));",
			"vi.doMock(`../clients/${'project-trust'}.js`, () => ({}));",
			'vi["mo" + "ck"]("../clients/project-trust.js", () => ({}));',
			'getVitest().doMock("../clients/project-trust.js", () => ({}));',
			'jest.mock("../clients/project-trust.js");',
			"vi.fn(target);",
			"const helper = { mock: (path: string) => path };",
			'helper.mock("../clients/project-trust.js");',
			"const { doMock: dm } = getVitest();",
			'dm("../clients/project-trust.js");',
			"const late = getVitest().mock;",
			'late("../clients/project-trust.js");',
			"let held;",
			"held = vi;",
			'held.mock("../clients/project-trust.js");',
			'for (const doMock of [vi.doMock]) doMock("../clients/project-trust.js");',
		].join("\n");
		expect(
			scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
		).toEqual({
			count: 0,
			unclassified: [
				"unclassified spelling at fake.test.ts:2: vi.mock(target, () => ({}));",
				"unclassified spelling at fake.test.ts:3: vi.doMock(`../clients/${'project-trust'}.js`, () => ({}));",
				'unclassified spelling at fake.test.ts:4: vi["mo" + "ck"]("../clients/project-trust.js", () => ({}));',
				'unclassified spelling at fake.test.ts:5: getVitest().doMock("../clients/project-trust.js", () => ({}));',
				'unclassified spelling at fake.test.ts:6: jest.mock("../clients/project-trust.js");',
				'unclassified spelling at fake.test.ts:11: dm("../clients/project-trust.js");',
				'unclassified spelling at fake.test.ts:13: late("../clients/project-trust.js");',
				'unclassified spelling at fake.test.ts:16: held.mock("../clients/project-trust.js");',
				'unclassified spelling at fake.test.ts:17: for (const doMock of [vi.doMock]) doMock("../clients/project-trust.js");',
			],
		});
	});

	it("ignores an unclassifiable spelling inside a comment or a string (#4429)", () => {
		const source = [
			"// vi.mock(target, () => ({}));",
			"const text = 'vi.mock(target) vi[key](\"../clients/project-trust.js\")';",
		].join("\n");
		expect(
			scanViMockSites("fake.test.ts", source, "clients/project-trust.js"),
		).toEqual({ count: 0, unclassified: [] });
	});
});
