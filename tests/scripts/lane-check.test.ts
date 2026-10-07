import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	classifyFailureFiles,
	laneExitCode,
} from "../../scripts/lane-check.mjs";

describe("lane-check failure classification (#4047)", () => {
	const fixture = (name: string) =>
		JSON.parse(
			fs.readFileSync(
				new URL(`./fixtures/${name}.json`, import.meta.url),
				"utf8",
			),
		);

	// Recurrence: workers called changed reds unrelated without red-on-base.
	it("wires each failing file to its red-on-base verdict", () => {
		const changed = fixture("lane-check-caused-by-change");
		const base = fixture("lane-check-red-on-base");
		expect(
			classifyFailureFiles([changed.file, base.file], {
				[changed.file]: changed.verdict,
				[base.file]: base.verdict,
			}),
		).toEqual([
			{ file: "tests/a.test.ts", verdict: "CAUSED-BY-CHANGE" },
			{ file: "tests/b.test.ts", verdict: "RED-ON-BASE" },
		]);
	});

	it("exits non-zero for a changed fixture failure and zero for a base fixture failure", () => {
		expect(laneExitCode([{ verdict: "CAUSED-BY-CHANGE" }])).toBe(1);
		expect(laneExitCode([{ verdict: "RED-ON-BASE" }])).toBe(0);
	});
});
