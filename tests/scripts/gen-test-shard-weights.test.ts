import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildWeights,
	testFileId,
} from "../../scripts/gen-test-shard-weights.mjs";

// #3771: the weights snapshot is regenerated from CI's per-shard vitest JSON.
// Recurrence: a regeneration that keys on the CI checkout's absolute prefix
// (every key then mismatches the sequencer's repo-relative ids and the whole
// snapshot reads as "unmodeled"), or that takes one slow runner's number.

function report(dir: string, name: string, entries: Array<[string, number]>) {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			testResults: entries.map(([test, seconds]) => ({
				name: test,
				startTime: 1000,
				endTime: 1000 + seconds * 1000,
			})),
		}),
	);
	return file;
}

describe("#3771 test shard weights generator", () => {
	it("keys files repo-relative whatever the checkout prefix", () => {
		expect(
			testFileId("/home/runner/work/pi-lens/pi-lens/tests/a/b.test.ts"),
		).toBe("tests/a/b.test.ts");
		expect(testFileId("C:\\work\\pi-lens\\tests\\a\\b.test.ts")).toBe(
			"tests/a/b.test.ts",
		);
		expect(testFileId("/elsewhere/not-a-test.ts")).toBeNull();
	});

	it("takes the per-run median, merges shards of one run and sorts the keys", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shard-gen-"));
		try {
			const prefix = "/home/runner/work/pi-lens/pi-lens";
			const run1 = [
				report(dir, "r1/s1/vitest-results.json", [
					[`${prefix}/tests/z.test.ts`, 1],
				]),
				report(dir, "r1/s2/vitest-results.json", [
					[`${prefix}/tests/a.test.ts`, 2],
				]),
			];
			const run2 = [
				report(dir, "r2/s1/vitest-results.json", [
					[`${prefix}/tests/z.test.ts`, 9],
					[`${prefix}/tests/a.test.ts`, 4],
				]),
			];
			const run3 = [
				report(dir, "r3/s1/vitest-results.json", [
					[`${prefix}/tests/z.test.ts`, 3],
				]),
			];
			const weights = buildWeights([run1, run2, run3]);
			expect(Object.keys(weights)).toEqual([
				"tests/a.test.ts",
				"tests/z.test.ts",
			]);
			expect(weights["tests/z.test.ts"]).toBe(3);
			expect(weights["tests/a.test.ts"]).toBe(3);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
