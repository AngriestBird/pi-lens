import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const root = path.resolve(import.meta.dirname, "../..");
const load = (file: string) =>
	yaml.load(fs.readFileSync(path.join(root, file), "utf8")) as Record<
		string,
		any
	>;

describe("#3215 durable test-history workflow contract", () => {
	it("keeps the default reporter and adds a uniquely named Linux artifact", () => {
		const workflow = load(".github/workflows/ci.yml");
		const steps = workflow.jobs.test.steps as Array<Record<string, any>>;
		const run = steps.find((step) => step.name === "Run tests");
		if (!run) throw new Error("Run tests step is missing");
		expect(run.run).toContain("--reporter=default");
		expect(run.run).toContain("--reporter=json");
		const upload = steps.find(
			(step) => step.name === "Upload per-file test results",
		);
		if (!upload) throw new Error("test-history upload step is missing");
		expect(upload.with.name).toBe("unit-test-results-linux");
		expect(upload.if).toBe("always()");
	});

	it("runs rollup only from the scheduled nightly and grants data-branch write access", () => {
		const workflow = load(".github/workflows/tool-smoke.yml");
		expect(workflow.jobs["test-history-rollup"].if).toBe(
			"github.event_name == 'schedule'",
		);
		expect(workflow.jobs["test-history-rollup"].permissions.contents).toBe(
			"write",
		);
	});
});
