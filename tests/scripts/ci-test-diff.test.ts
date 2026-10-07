import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	compareFailureSets,
	extractFailingTestIds,
	stripLogDecorations,
	validateLog,
} from "../../scripts/ci-test-diff.mjs";

const fixture = (name: string) =>
	fs.readFileSync(path.join("tests/fixtures/ci-test-diff", name), "utf8");

describe("ci-test-diff failure extraction", () => {
	// Recurrence: #4072's Windows logs contain ANSI, CRLF, and Actions timestamps;
	// the tool must compare test identities rather than the aggregate failure count.
	it("reproduces the 7 fixed / 7 new / 51 unchanged witness", () => {
		const master = extractFailingTestIds(
			stripLogDecorations(fixture("job-112724408671.log")),
		);
		const round2 = extractFailingTestIds(
			stripLogDecorations(fixture("job-112734370876.log")),
		);
		const diff = compareFailureSets(master, round2);

		expect(master).toHaveLength(58);
		expect(round2).toHaveLength(58);
		expect(diff.fixed).toHaveLength(7);
		expect(diff.newFailures).toHaveLength(7);
		expect(diff.unchanged).toHaveLength(51);
		expect(diff.fixed).toContain(
			"default::tests/clients/path-utils.test.ts › normalizeFilePath: dot segments fold into the canonical key (#3184) > an empty string is returned unchanged, not invented into the cwd",
		);
		expect(diff.newFailures).toContain(
			"default::tests/clients/read-guard-path-normalization.test.ts › ReadGuard path-key normalization (zero_read false-block regression) > getReadHistory matches across separator forms",
		);
	});

	it("normalizes Actions timestamps and terminal decoration", () => {
		const raw =
			"2026-10-07T00:00:00.000Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default  tests/a.test.ts\r\n";
		expect(stripLogDecorations(raw)).toBe("FAIL  default  tests/a.test.ts\n");
	});

	it("covers collection, unnamed-project, fallback, and non-tests-root FAIL shapes", () => {
		const raw = [
			"job\tstep\t2026-10-07T00:00:00.000Z FAIL tests/imp.test.ts [ tests/imp.test.ts ]",
			"FAIL tests/single.test.ts > s > a > b",
			"FAIL TS clients/other.spec.ts > labelled",
		].join("\n");
		expect(extractFailingTestIds(stripLogDecorations(raw))).toEqual([
			"TS::clients/other.spec.ts › labelled",
			"tests/imp.test.ts",
			"tests/single.test.ts › s > a > b",
		]);
	});

	it("rejects incomplete or mismatched Vitest summaries", () => {
		expect(() =>
			validateLog("FAIL default tests/a.test.ts > t", "job A"),
		).toThrow("job A log incomplete");
		expect(() =>
			validateLog("Tests 1 failed\nFailed Tests 2", "job B"),
		).toThrow("mismatched Vitest failure summaries");
	});

	it("keeps project names in identities", () => {
		const log =
			"Tests 2 failed\n" +
			"Failed Tests 2\n" +
			"FAIL web tests/same.test.ts > same\n" +
			"FAIL node tests/same.test.ts > same\n";
		expect(validateLog(log).ids).toEqual([
			"node::tests/same.test.ts › same",
			"web::tests/same.test.ts › same",
		]);
	});

	it("returns 0 for unchanged, 1 for NEW, and 2 for invalid job logs", () => {
		const scratch = fs.mkdtempSync(
			path.join(process.env.TMPDIR ?? os.tmpdir(), "ci-test-diff-"),
		);
		const gh = path.join(scratch, "gh");
		const fixtureDir = path.resolve("tests/fixtures/ci-test-diff");
		const fixtureA = path.join(fixtureDir, "job-112724408671.log");
		const fixtureB = path.join(fixtureDir, "job-112734370876.log");
		fs.writeFileSync(
			gh,
			`#!/usr/bin/env node\nconst fs = require("node:fs");\nconst request = process.argv.find((value) => value.includes("/jobs/")) ?? "";\nconst id = request.match(/\\/jobs\\/(\\d+)\\//)?.[1];\nconst file = id === "0" ? null : id === "2" ? ${JSON.stringify(fixtureB)} : ${JSON.stringify(fixtureA)};\nif (file) process.stdout.write(fs.readFileSync(file, "utf8"));\n`,
		);
		fs.chmodSync(gh, 0o755);
		const env = { ...process.env, PATH: `${scratch}:${process.env.PATH}` };
		const run = (a: string, b: string) =>
			spawnSync(process.execPath, ["scripts/ci-test-diff.mjs", a, b], {
				cwd: path.resolve("."),
				encoding: "utf8",
				env,
			});
		expect(run("1", "1").status).toBe(0);
		expect(run("1", "2").status).toBe(1);
		expect(run("0", "1").status).toBe(2);
		fs.rmSync(scratch, { recursive: true, force: true });
	});
});
