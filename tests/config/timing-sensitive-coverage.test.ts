import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toPosix } from "../../clients/path-utils.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configText = fs.readFileSync(path.join(repoRoot, "vitest.config.ts"), "utf8");

// Deliberate exception: these tests validate the sampler itself with synthetic
// busy-loop/yielding examples, rather than guarding a production timing budget.
const timingMeasurementOnly = new Set(["tests/support/perf-harness.test.ts"]);

function testFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) return testFiles(entryPath);
		return entry.name.endsWith(".test.ts") ? [entryPath] : [];
	});
}

function timingSensitiveInclude(): Set<string> {
	const arrayBody = configText.match(
		/const timingSensitiveInclude = \[(?<body>[\s\S]*?)\];/,
	)?.groups?.body;
	if (!arrayBody) throw new Error("vitest.config.ts has no timingSensitiveInclude array");
	return new Set(
		[...arrayBody.matchAll(/"(tests\/[^"]+\.test\.ts)"/g)].map((match) => match[1]),
	);
}

function budgetAssertions(source: string): boolean {
	const helper = "measureMaxSyncBlock" + "Ms";
	const measurements = [...source.matchAll(
		new RegExp(String.raw`(?:const|let)\s+(\w+)\s*=\s*await\s+${helper}\s*\(`, "g"),
	)].map((match) => match[1]);
	return measurements.some((name) =>
		new RegExp(String.raw`expect\(\s*${name}\s*\)\s*\.`, "m").test(source),
	) || (source.includes("process." + "cpuUsage") && /expect\(\s*cpuMs\s*\)\s*\./m.test(source));
}

describe("timing-sensitive Vitest project coverage", () => {
	it("phases every occupancy/CPU budget assertion", () => {
		const included = timingSensitiveInclude();
		const budgetFiles = testFiles(path.join(repoRoot, "tests"))
			.map((file) => toPosix(path.relative(repoRoot, file)))
			.filter((file) => budgetAssertions(fs.readFileSync(path.join(repoRoot, file), "utf8")));
		const unexpected = budgetFiles.filter(
			(file) => !included.has(file) && !timingMeasurementOnly.has(file),
		);

		expect(unexpected, "budget-asserting tests must be in timingSensitiveInclude").toEqual([]);
		expect([...timingMeasurementOnly].filter((file) => budgetFiles.includes(file))).toEqual([
			"tests/support/perf-harness.test.ts",
		]);
	});
});
