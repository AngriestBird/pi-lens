import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const root = path.resolve(import.meta.dirname, "../..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const load = (file: string) =>
	yaml.load(fs.readFileSync(path.join(root, file), "utf8")) as Record<
		string,
		unknown
	>;

describe("#3215 durable test-history workflow contract", () => {
	it("pins the reporter console contract and Linux artifact", () => {
		const workflow = load(".github/workflows/ci.yml");
		const jobs = workflow.jobs as Record<string, unknown>;
		const testJob = jobs.test as Record<string, unknown>;
		const steps = testJob.steps as Array<Record<string, unknown>>;
		const run = steps.find((step) => step.name === "Run tests");
		if (!run) throw new Error("Run tests step is missing");
		const command = String(run.run);
		expect(command).toContain("--reporter=default");
		expect(command).toContain("--reporter=json");
		expect(command).toContain("--outputFile=");
		const upload = steps.find(
			(step) => step.name === "Upload per-file test results",
		);
		if (!upload) throw new Error("test-history upload step is missing");
		const uploadWith = upload.with as Record<string, unknown>;
		expect(uploadWith.name).toBe("unit-test-results-linux");
		expect(upload.if).toBe("always()");
		const metadata = steps.find(
			(step) => step.name === "Write test-history artifact metadata",
		);
		if (!metadata) throw new Error("test-history metadata step is missing");
		const metadataEnv = metadata.env as Record<string, unknown>;
		expect(metadataEnv.HEAD_SHA).toContain(
			"github.event.pull_request.head.sha",
		);

		const temp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-test-history-console-contract-"),
		);
		try {
			const env = {
				...process.env,
				PI_LENS_TEST_NO_LOCK: "1",
				PI_LENS_HOME: path.join(temp, "home"),
			};
			const run = (args: string[]) => {
				const result = spawnSync(npmCommand, ["test", "--", ...args], {
					cwd: root,
					env,
					encoding: "utf8",
				});
				expect(result.status).toBe(0);
				return `${result.stdout}${result.stderr}`;
			};
			const ciOutput = run([
				"tests/scripts/test-history-rollup.test.ts",
				"--reporter=default",
				"--reporter=json",
				`--outputFile=${path.join(temp, "ci-results.json")}`,
			]);
			expect(ciOutput.match(/^JSON report written to .+$/gm)).toHaveLength(1);
			const localOutput = run(["tests/scripts/test-history-rollup.test.ts"]);
			expect(localOutput).not.toMatch(/^JSON report written to .+$/m);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});

	it("runs rollup only from the scheduled nightly and grants data-branch write access", () => {
		const workflow = load(".github/workflows/tool-smoke.yml");
		const jobs = workflow.jobs as Record<string, unknown>;
		const rollup = jobs["test-history-rollup"] as Record<string, unknown>;
		expect(rollup.if).toBe("github.event_name == 'schedule'");
		const permissions = rollup.permissions as Record<string, unknown>;
		expect(permissions.contents).toBe("write");
	});
});
