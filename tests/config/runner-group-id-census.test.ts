import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SgNode } from "@ast-grep/napi";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { RunnerRegistry } from "../../clients/dispatch/dispatcher.js";
import { registerDefaultRunners } from "../../clients/dispatch/runners/index.js";
import { censusSourceFiles, parseRoot } from "../support/ast-census.js";
import {
	assertNonEmptyScan,
	readWalkedFiles,
	relativePosix,
} from "../support/sweep-kit.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const registry = new RunnerRegistry();
registerDefaultRunners(registry);

function propertyName(pair: SgNode): unknown {
	const raw = pair.field("key");
	const key =
		raw?.kind() === "computed_property_name"
			? raw.children().find((node) => node.isNamed())
			: raw;
	return key?.kind() === "string"
		? JSON5.parse<unknown>(key.text())
		: key?.text();
}

/** #4312: literal references must resolve against registrations, not declarations. */
function census(source: string): { ids: string[]; problems: string[] } {
	const ids: string[] = [];
	const problems: string[] = [];
	for (const pair of parseRoot(source).findAll({ rule: { kind: "pair" } })) {
		if (propertyName(pair) !== "runnerIds") continue;
		const value = pair.field("value");
		// Runtime-derived lists contain no direct literal references to check.
		if (value?.kind() !== "array") continue;
		const elements = value.children().filter((node) => node.isNamed());
		// Also named runnerIds: runtime result metadata, with no literal ids or
		// RunnerGroup mode (e.g. DispatchResult.inconclusiveSources).
		const hasMode = pair
			.parent()
			?.children()
			.some((node) => node.kind() === "pair" && propertyName(node) === "mode");
		if (!hasMode && !elements.some((node) => node.kind() === "string"))
			continue;
		for (const element of elements) {
			if (element.kind() === "comment") continue;
			const line = element.range().start.line + 1;
			if (element.kind() !== "string") {
				problems.push(`${line}: unclassified runner id ${element.text()}`);
				continue;
			}
			const id = JSON5.parse<string>(element.text());
			ids.push(id);
			if (!registry.get(id))
				problems.push(`${line}: unregistered runner id ${id}`);
		}
	}
	return { ids, problems };
}

describe("RunnerGroup literal id census (#4312)", () => {
	it("resolves every literal runnerIds member against the runner registry", () => {
		const files = censusSourceFiles(
			["clients", "tools", "mcp", "scripts", "index.ts"].map((dir) =>
				path.join(ROOT, dir),
			),
			{ extensions: [".ts", ".mjs", ".js", ".cjs"], skipTests: true },
		);
		assertNonEmptyScan("production sources", files.length, 600);
		assertNonEmptyScan("registered runners", registry.list().length, 40);
		const problems: string[] = [];
		let references = 0;
		for (const { file, source } of readWalkedFiles(files)) {
			const result = census(source);
			references += result.ids.length;
			problems.push(
				...result.problems.map(
					(problem) => `${relativePosix(ROOT, file)}:${problem}`,
				),
			);
		}
		assertNonEmptyScan("literal runner id references", references, 100);
		expect(problems).toEqual([]);
	});

	it("checks quoted and computed literal keys without counting prose", () => {
		const result = census(`
			// runnerIds: ["comment-only"]
			const prose = 'runnerIds: ["string-only"]';
			const metadata = { runnerIds: [...inconclusiveRunnerIds] };
			const groups = [{ runnerIds: ["lsp"] },
				{ "runnerIds": ["not-registered"] },
				{ ["runnerIds"]: ['also-not-registered'] },
				{ ["runner\\u0049ds"]: ['escaped-not-registered'] }];
		`);
		expect(result.ids).toEqual([
			"lsp",
			"not-registered",
			"also-not-registered",
			"escaped-not-registered",
		]);
		expect(result.problems).toHaveLength(3);
		expect(
			result.problems.every((problem) => problem.includes("unregistered")),
		).toBe(true);
	});

	it.each([
		'const alias = "missing"; const group = { mode: "all", runnerIds: [alias] };',
		'const getId = () => "missing"; const group = { "mode": "all", runnerIds: [getId()] };',
		'const ids = ["missing"]; const group = { ["mode"]: "all", runnerIds: [...ids] };',
	])(
		"refuses a nonliteral member instead of silently skipping it: %s",
		(source) => {
			// Shape 69: alias, indirect call, and a value through another binding.
			expect(census(source).problems).toEqual([
				expect.stringContaining("unclassified runner id"),
			]);
		},
	);
});
