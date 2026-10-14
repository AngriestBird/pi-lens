import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseDiagnostics,
	runCheck,
	type StrictnessResult,
} from "../../scripts/strictness-report.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const baseline = JSON.parse(
	readFileSync(
		resolve(import.meta.dirname, "strictness-baseline.json"),
		"utf8",
	),
) as Record<string, Record<string, number>>;
// `index.ts` is the host adapter at the repo root; before #4429 its errors
// fell into an `other` bucket this filter dropped, so they were unratcheted.
const productionRoots = ["clients", "tools", "mcp", "scripts", "index.ts"];

function productionCounts(result: Pick<StrictnessResult, "counts">) {
	return Object.fromEntries(
		Object.entries(result.counts).filter(([directory]) =>
			productionRoots.some(
				(root) => directory === root || directory.startsWith(`${root}/`),
			),
		),
	);
}

function compare(
	result: Pick<StrictnessResult, "counts" | "unclassified">,
	expected: Record<string, number>,
) {
	const actual = productionCounts(result);
	// #4429: a tsc line the parser cannot place in a bucket reds, never skips.
	const problems: string[] = result.unclassified.map(
		(line) => `unclassified spelling: ${line}`,
	);
	for (const directory of new Set([
		...Object.keys(actual),
		...Object.keys(expected),
	])) {
		const before = expected[directory] ?? 0;
		const after = actual[directory] ?? 0;
		if (after > before)
			problems.push(`${directory}: regression (${before} -> ${after})`);
		if (after < before)
			problems.push(
				`${directory}: ratchet down — lower the baseline (${before} -> ${after})`,
			);
	}
	return problems;
}

describe("TypeScript strictness spike ratchets", () => {
	it("pins both scratch configurations without permitting drift", () => {
		const results = [
			runCheck("tsconfig.strict-indexed.json", ROOT),
			runCheck("tsconfig.strict-optional.json", ROOT),
		];
		for (const result of results) {
			expect(result.exitCode).toBe(1);
			expect(result.total).toBeGreaterThan(0);
			expect(compare(result, baseline[result.config])).toEqual([]);
		}
	}, 120_000);

	it("reds on a tsc diagnostic the parser cannot place (#4429)", () => {
		// Recurrence: #4411 review F3, a population scanner that skipped
		// spellings it did not recognise. Line 2 is real tsc 5 output for a
		// missing `types` entry (captured with --pretty false): a global
		// diagnostic with no file location. Line 4 sits outside every root.
		const output = [
			"clients/a.ts(1,2): error TS2532: Object is possibly 'undefined'.",
			"error TS2688: Cannot find type definition file for 'ghost-types'.",
			"  The file is in the program because:",
			"../outside/b.ts(3,4): error TS2322: Type 'string' is not assignable to type 'number'.",
			"index.ts(5,6): error TS2322: Type 'string' is not assignable to type 'number'.",
		].join("\n");
		expect(
			compare(parseDiagnostics(output, ROOT), { clients: 1, "index.ts": 1 }),
		).toEqual([
			"unclassified spelling: error TS2688: Cannot find type definition file for 'ghost-types'.",
			"unclassified spelling: ../outside/b.ts(3,4): error TS2322: Type 'string' is not assignable to type 'number'.",
		]);
	});
});
