import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

type PullRequestTrigger = { types?: string[] };
type Workflow = {
	on?: { pull_request?: PullRequestTrigger };
	concurrency?: { group?: unknown; "cancel-in-progress"?: unknown };
};

function loadWorkflow(file: string): Workflow {
	return yaml.load(readFileSync(resolve(WORKFLOWS, file), "utf8")) as Workflow;
}

describe("workflow concurrency edit safety", () => {
	it("does not share an edited PR group with synchronize", () => {
		// Recurrence #3716: a PR body/title edit must not cancel the pushed head's
		// heavy CI or lint run through a cancel-in-progress group collision.
		const findings: string[] = [];
		for (const file of readdirSync(WORKFLOWS)) {
			if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
			const workflow = loadWorkflow(file);
			const trigger = workflow.on?.pull_request;
			if (!trigger || workflow.concurrency?.["cancel-in-progress"] !== true) {
				continue;
			}
			const group = workflow.concurrency.group;
			if (typeof group !== "string" || !group.includes("github.event.action")) {
				findings.push(
					`${file}: edited and synchronize can share ${String(group)}`,
				);
			}
		}
		expect(
			findings,
			"canceling pull_request groups must distinguish action",
		).toEqual([]);
	});
});
