import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rollupTestHistory } from "../../scripts/test-history-rollup.mjs";

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-test-history-"));
	roots.push(root);
	const artifact = path.join(root, "artifact");
	fs.mkdirSync(artifact);
	fs.writeFileSync(
		path.join(artifact, "metadata.json"),
		JSON.stringify({
			headSha: "head-a",
			runId: 101,
			lane: "linux",
			recordedAt: "2026-09-22T00:00:00.000Z",
		}),
	);
	fs.writeFileSync(
		path.join(artifact, "vitest.json"),
		JSON.stringify({
			testResults: [
				{ name: "tests/flaky.test.ts", status: "failed", duration: 12 },
				{ name: "tests/steady.test.ts", status: "passed", duration: 8 },
			],
		}),
	);
	return { root, artifact };
}

describe("test-history-rollup real entry point", () => {
	it("writes one row per test file and identifies same-head pass/fail evidence", () => {
		const { root, artifact } = fixture();
		const second = path.join(root, "artifact-2");
		fs.mkdirSync(second);
		fs.writeFileSync(
			path.join(second, "metadata.json"),
			JSON.stringify({
				headSha: "head-a",
				runId: 102,
				lane: "linux",
				recordedAt: "2026-09-22T01:00:00.000Z",
			}),
		);
		fs.writeFileSync(
			path.join(second, "vitest.json"),
			JSON.stringify({
				testResults: [
					{ name: "tests/flaky.test.ts", status: "passed", duration: 10 },
				],
			}),
		);
		const history = path.join(root, "history.ndjson");
		const summary = path.join(root, "summary.json");
		const output = rollupTestHistory({
			artifactPaths: [artifact, second],
			historyPath: history,
			summaryPath: summary,
			now: Date.parse("2026-09-23T00:00:00.000Z"),
		});
		expect(output.rowCount).toBe(2);
		expect(output.flakeCandidates).toEqual([
			{ file: "tests/flaky.test.ts", headSha: "head-a" },
		]);
		expect(fs.readFileSync(history, "utf8").trim().split("\n")).toHaveLength(2);
		expect(JSON.parse(fs.readFileSync(summary, "utf8")).files).toEqual(
			expect.arrayContaining([
				{
					file: "tests/flaky.test.ts",
					passCount: 1,
					failCount: 1,
					lastFailHead: "head-a",
					meanDurationMs: 11,
				},
			]),
		);
	});

	it("prunes rows older than 90 days while retaining current rows", () => {
		const { root, artifact } = fixture();
		const oldHistory = path.join(root, "history.ndjson");
		fs.writeFileSync(
			oldHistory,
			`${JSON.stringify({ headSha: "old", runId: "1", file: "old.test.ts", outcome: "passed", durationMs: 1, lane: "linux", recordedAt: "2026-01-01T00:00:00.000Z" })}\n`,
		);
		const summary = path.join(root, "summary.json");
		const output = rollupTestHistory({
			artifactPaths: [artifact],
			historyPath: oldHistory,
			summaryPath: summary,
			now: Date.parse("2026-09-23T00:00:00.000Z"),
		});
		expect(output.rowCount).toBe(2);
		expect(fs.readFileSync(oldHistory, "utf8")).not.toContain(
			'"headSha":"old"',
		);
	});
});
