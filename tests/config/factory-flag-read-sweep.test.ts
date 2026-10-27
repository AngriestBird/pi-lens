/**
 * No flag read runs while the extension factory runs (#4913).
 *
 * RECURRENCE THIS PREVENTS: #4913. pi applies the command-line value of an
 * extension flag AFTER every factory has run, so `pi.getFlag` inside the
 * factory answers the registered default. `index.ts` read `no-lens`,
 * `no-lens-context`, `lens-compact-tool-line` and `--no-tool` at the factory's
 * top level and `pi --no-lens` started language servers. The detector, its
 * state table and its residual are in `tests/support/factory-flag-read-scan.ts`.
 *
 * Runtime observation of the host's order is `tests/index-4913-cli-flag-timing.test.ts`
 * (tier 2); this sweep is the source-level fence that keeps a NEW factory-time
 * read out, which a runtime case for the four known flags cannot (AGENTS.md
 * shape 33: a source scan is admitted where the population is "every read in
 * the factory", not four named flags).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type FactoryFlagAdmission,
	scanFactoryFlagReads,
} from "../support/factory-flag-read-scan.js";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const indexSource = fs.readFileSync(path.join(ROOT, "index.ts"), "utf-8");

/** Refused sites the tree admits, each keyed `<function>:<binding>:<reader>:<form>`. */
const ADMITTED: FactoryFlagAdmission = {
	"activateExtension:<top>:getLensFlag:assignment_expression":
		"`_bridgeGetFlag = getLensFlag` stores the closure for the read/mutation/io bridges, which call it per event, never while the factory runs",
	"activateExtension:enabledLazyTools:isToolEnabled:call":
		"registration decides on the config tiers, which are readable at factory time; the CLI value reaches `applyToolSetPlan` and `pi_lens_activate_tools` through `isToolEnabled` at use",
	"activateExtension:toolsToRegister:isToolEnabled:call":
		"same registration filter as `enabledLazyTools`: config tiers at registration, the CLI value at session_start",
	"activateExtension:alwaysActiveTools:getLensFlag:call":
		"closures handed to the tool constructors (`createLensDiagnosticsTool`), which store them and call them per tool execution",
	"activateExtension:lazyTools:getLensFlag:call":
		"the closure handed to `createLspNavigationTool`, which stores it and calls it per tool execution",
	"createHostPorts:<top>:getFlag:call":
		"the ports table's `flags.get` closure: its consumers call it at event time, never while `createHostPorts` builds the table",
};

/** A factory whose body is `body`, with the readers a real one has. */
function factory(body: string): string {
	return [
		"function activateExtension(pi: any) {",
		"\tconst getLensFlag = (name: string) => pi.getFlag(name);",
		"\tconst register = (_: unknown) => undefined;",
		`\t${body}`,
		"}",
		"export default function (pi: any) { return activateExtension(pi); }",
		"",
	].join("\n");
}

describe("factory-time flag reads (#4913)", () => {
	it("reads no flag at the top of index.ts's factory, apart from the admitted registration sites", () => {
		const scan = scanFactoryFlagReads(indexSource, ADMITTED);
		expect(scan.population, "the scan reached the factory").toContain(
			"activateExtension",
		);
		expect(
			scan.unadmitted.map((site) => `${site.line}: ${site.key} (${site.form})`),
			"a flag read that runs while the factory runs reads pi's default, not the command line",
		).toEqual([]);
		expect(scan.staleAdmissions, "every admission row is used").toEqual([]);
		// The admitted rows are the ones the table names, nothing wider.
		expect([...new Set(scan.sites.map((site) => site.key))].sort()).toEqual(
			Object.keys(ADMITTED).sort(),
		);
	});

	it("refuses the read #4913 shipped: a flag read assigned at the factory's top level", () => {
		const mutated = indexSource.replace(
			"let lensEnabled = true;",
			'let lensEnabled = !getLensFlag("no-lens");',
		);
		expect(mutated, "the mutation applied").not.toBe(indexSource);
		const scan = scanFactoryFlagReads(mutated, ADMITTED);
		expect(scan.unadmitted.map((site) => site.key)).toEqual([
			"activateExtension:lensEnabled:getLensFlag:call",
		]);
	});

	describe("spellings the author did not design for", () => {
		const refused: Array<[string, string, string]> = [
			[
				"a direct call",
				'const on = !getLensFlag("no-lens");',
				"activateExtension:on:getLensFlag:call",
			],
			[
				"an alias",
				'const g = getLensFlag; const on = g("no-lens");',
				"activateExtension:g:getLensFlag:variable_declarator",
			],
			[
				"an indirect call through a local function",
				'const read = () => getLensFlag("no-lens"); const on = read();',
				"activateExtension:on:read:call",
			],
			[
				"a value reached through another binding",
				'const o = { get: getLensFlag }; const on = o.get("no-lens");',
				"activateExtension:o:getLensFlag:pair-value",
			],
			[
				"the host member",
				'const on = pi.getFlag("no-lens");',
				"activateExtension:on:getFlag:call",
			],
			[
				"a synchronous array callback",
				'const on = ["a"].filter((n) => getLensFlag(n));',
				"activateExtension:on:getLensFlag:call",
			],
			[
				"an array element",
				"const list = [getLensFlag]; list[0]('x');",
				"activateExtension:list:getLensFlag:array",
			],
			[
				"a call through .call",
				'const on = getLensFlag.call(undefined, "no-lens");',
				"activateExtension:on:getLensFlag:member_expression",
			],
			// #4917 F2: each of these ran while the factory ran and scanned green
			// when the detector enumerated synchronous callbacks instead of the
			// forms that only defer one.
			[
				"an immediately invoked arrow function",
				'const on = (() => getLensFlag("no-lens"))();',
				"activateExtension:on:getLensFlag:call",
			],
			[
				"an immediately invoked function expression",
				'const on = (function () { return getLensFlag("no-lens"); })();',
				"activateExtension:on:getLensFlag:call",
			],
			[
				"an object method the factory invokes",
				'const o = { m() { return getLensFlag("no-lens"); } }; const on = o.m();',
				"activateExtension:o:getLensFlag:call",
			],
			[
				"an object property function the factory invokes",
				'const o = { m: () => getLensFlag("no-lens") }; const on = o.m();',
				"activateExtension:o:getLensFlag:call",
			],
			[
				"a new Promise executor",
				'const p = new Promise((resolve) => resolve(getLensFlag("no-lens")));',
				"activateExtension:p:getLensFlag:call",
			],
			[
				"a constructor call inside a registrar's argument",
				'pi.on("x", new Handler(() => getLensFlag("no-lens")));',
				"activateExtension:<top>:getLensFlag:call",
			],
			[
				"a reader handed to a constructor",
				"const h = new Handler(getLensFlag);",
				"activateExtension:h:getLensFlag:new-argument",
			],
			[
				"a wrapper call that is not a registrar's argument",
				'const on = wrap(() => getLensFlag("no-lens"));',
				"activateExtension:on:getLensFlag:call",
			],
		];
		it.each(refused)("refuses %s", (_name, body, key) => {
			const scan = scanFactoryFlagReads(factory(body));
			expect(scan.unadmitted.map((site) => site.key)).toContain(key);
		});

		it("refuses a module-level helper the factory calls while it runs", () => {
			// #4917 F2: the helper is not the default export's body, so a scan of
			// only that body never read it.
			const source = [
				"function readNoLens(pi: any) { return pi.getFlag('no-lens'); }",
				"function activateExtension(pi: any) {",
				"\tconst on = readNoLens(pi);",
				"}",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			const scan = scanFactoryFlagReads(source);
			expect(scan.population).toEqual(["activateExtension", "readNoLens"]);
			expect(scan.unadmitted.map((site) => site.key)).toContain(
				"readNoLens:<top>:getFlag:call",
			);
		});

		it("follows the helper chain transitively", () => {
			const source = [
				"function inner(pi: any) { return pi.getFlag('no-lens'); }",
				"const outer = (pi: any) => inner(pi);",
				"function activateExtension(pi: any) { outer(pi); }",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			const scan = scanFactoryFlagReads(source);
			expect(scan.population).toEqual(["activateExtension", "outer", "inner"]);
			expect(scan.unadmitted.map((site) => site.key)).toContain(
				"inner:<top>:getFlag:call",
			);
		});

		const admitted: Array<[string, string]> = [
			[
				"a handler the host calls later",
				'pi.on("session_start", () => getLensFlag("no-lens"));',
			],
			[
				"a handler wrapped by a call whose result is the registrar's argument",
				'pi.on("session_start", wrap("session_start", async () => getLensFlag("no-lens")));',
			],
			[
				"a command handler inside an options object",
				'pi.registerCommand("x", { handler: () => getLensFlag("no-lens") });',
			],
			["a timer callback", 'setTimeout(() => getLensFlag("no-lens"), 10);'],
			[
				"a promise continuation",
				'Promise.resolve().then(() => getLensFlag("no-lens"));',
			],
			[
				"a callback handed to a callee that stores it",
				"register(getLensFlag);",
			],
			[
				"a function declared and never called while the factory runs",
				'const later = () => getLensFlag("no-lens");',
			],
			[
				"a nested function declaration",
				'function later() { return getLensFlag("no-lens"); }',
			],
			[
				"a comment or string that quotes the call",
				'// getLensFlag("no-lens")\nconst note = "getLensFlag(x)";',
			],
		];
		it.each(admitted)("admits %s", (_name, body) => {
			const scan = scanFactoryFlagReads(factory(body));
			expect(scan.unadmitted).toEqual([]);
		});

		it("admits a module-level helper that only a handler calls", () => {
			const source = [
				"function readNoLens(pi: any) { return pi.getFlag('no-lens'); }",
				"function activateExtension(pi: any) {",
				"\tpi.on('session_start', () => readNoLens(pi));",
				"}",
				"export default function (pi: any) { return activateExtension(pi); }",
				"",
			].join("\n");
			const scan = scanFactoryFlagReads(source);
			expect(scan.population).toEqual(["activateExtension"]);
			expect(scan.unadmitted).toEqual([]);
		});
	});

	it("fails closed when the source has no default export", () => {
		expect(() => scanFactoryFlagReads("function a() {}")).toThrow(
			/no default export/,
		);
	});
});
