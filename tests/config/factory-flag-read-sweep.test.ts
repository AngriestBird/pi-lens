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

/** Refused sites the tree admits, each keyed `<binding>:<reader>`. */
const ADMITTED: FactoryFlagAdmission = {
	"<top>:getLensFlag":
		"`_bridgeGetFlag = getLensFlag` stores the closure for the read/mutation/io bridges, which call it per event, never while the factory runs",
	"enabledLazyTools:isToolEnabled":
		"registration decides on the config tiers, which are readable at factory time; the CLI value reaches `applyToolSetPlan` and `pi_lens_activate_tools` through `isToolEnabled` at use",
	"toolsToRegister:isToolEnabled":
		"same registration filter as `enabledLazyTools`: config tiers at registration, the CLI value at session_start",
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
		// The admitted rows are the three the table names, nothing wider.
		expect(scan.sites.map((site) => site.key).sort()).toEqual(
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
			"lensEnabled:getLensFlag",
		]);
	});

	describe("spellings the author did not design for", () => {
		const refused: Array<[string, string, string]> = [
			[
				"a direct call",
				'const on = !getLensFlag("no-lens");',
				"on:getLensFlag",
			],
			[
				"an alias",
				'const g = getLensFlag; const on = g("no-lens");',
				"g:getLensFlag",
			],
			[
				"an indirect call through a local function",
				'const read = () => getLensFlag("no-lens"); const on = read();',
				"on:read",
			],
			[
				"a value reached through another binding",
				'const o = { get: getLensFlag }; const on = o.get("no-lens");',
				"o:getLensFlag",
			],
			["the host member", 'const on = pi.getFlag("no-lens");', "on:getFlag"],
			[
				"a synchronous array callback",
				'const on = ["a"].filter((n) => getLensFlag(n));',
				"on:getLensFlag",
			],
			[
				"an array element",
				"const list = [getLensFlag]; list[0]('x');",
				"list:getLensFlag",
			],
			[
				"a call through .call",
				'const on = getLensFlag.call(undefined, "no-lens");',
				"on:getLensFlag",
			],
		];
		it.each(refused)("refuses %s", (_name, body, key) => {
			const scan = scanFactoryFlagReads(factory(body));
			expect(scan.unadmitted.map((site) => site.key)).toContain(key);
		});

		const admitted: Array<[string, string]> = [
			[
				"a handler the host calls later",
				'pi.on("session_start", () => getLensFlag("no-lens"));',
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
				"a comment or string that quotes the call",
				'// getLensFlag("no-lens")\nconst note = "getLensFlag(x)";',
			],
		];
		it.each(admitted)("admits %s", (_name, body) => {
			const scan = scanFactoryFlagReads(factory(body));
			expect(scan.unadmitted).toEqual([]);
		});
	});

	it("fails closed when the source has no default export", () => {
		expect(() => scanFactoryFlagReads("function a() {}")).toThrow(
			/no default export/,
		);
	});
});
