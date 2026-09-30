import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

type PullRequestTrigger = { types?: string[] };
type PushTrigger = { branches?: string[] };
type Workflow = {
	on?: { pull_request?: PullRequestTrigger; push?: PushTrigger };
	concurrency?: { group?: unknown; "cancel-in-progress"?: unknown };
};

function loadWorkflow(file: string): Workflow {
	return yaml.load(readFileSync(resolve(WORKFLOWS, file), "utf8")) as Workflow;
}

function resolveValue(
	value: string,
	action: string,
	runId: string,
): string | boolean {
	const trimmed = value.trim();
	if (trimmed === "'edited'" || trimmed === '"edited"') return "edited";
	if (trimmed === "'pull_request'" || trimmed === '"pull_request"') {
		return "pull_request";
	}
	if (trimmed === "'default'" || trimmed === '"default"') return "default";
	if (trimmed === "''" || trimmed === '""') return "";
	const quoted = trimmed.match(/^(?:'([^']*)'|"([^"]*)")$/);
	if (quoted) return quoted[1] ?? quoted[2] ?? "";
	if (trimmed === "github.event.action") return action;
	if (trimmed === "github.event_name") return "pull_request";
	if (trimmed === "github.event.pull_request.number") return "42";
	if (trimmed === "github.ref") return "refs/pull/42/merge";
	if (trimmed === "github.event.client_payload.sha") return "dispatch-sha";
	if (trimmed === "github.run_id") return runId;
	return false;
}

function evaluateTerm(
	term: string,
	action: string,
	runId: string,
): string | boolean {
	const equality = term.split("==").map((part) => part.trim());
	if (equality.length === 2) {
		return (
			resolveValue(equality[0], action, runId) ===
			resolveValue(equality[1], action, runId)
		);
	}
	return resolveValue(term, action, runId);
}

function evaluateExpression(
	expression: string,
	action: string,
	runId: string,
): string | boolean {
	for (const alternative of expression.split("||")) {
		const conjunction = alternative
			.split("&&")
			.map((term) => evaluateTerm(term, action, runId));
		const value = conjunction.reduce<string | boolean>(
			(left, right) => (left ? right : left),
			true,
		);
		if (value) return value;
	}
	return "";
}

function evaluateGroup(group: string, action: string, runId: string): string {
	return group.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, expression: string) =>
		String(evaluateExpression(expression, action, runId)),
	);
}

function cancelInProgressOn(eventName: string, value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return false;
	const expression = value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
	return expression.split("||").some((alternative) =>
		alternative
			.split("&&")
			.map((term) => term.trim())
			.every((term) => {
				const equality = term.split("==").map((part) => part.trim());
				if (equality.length !== 2) return term === "true";
				const [left, right] = equality;
				const resolve = (operand: string) =>
					operand.replace(/^['\"]|['\"]$/g, "") === "github.event_name"
						? eventName
						: operand.replace(/^['\"]|['\"]$/g, "");
				return resolve(left) === resolve(right);
			}),
	);
}

describe("workflow concurrency edit safety", () => {
	it("never cancels a push to master", () => {
		// Recurrence #3798: every merge cancelled the master CI run before it
		// could finish, hiding the post-merge result behind the next merge.
		const findings: string[] = [];
		for (const file of readdirSync(WORKFLOWS)) {
			if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
			const workflow = loadWorkflow(file);
			if (!workflow.on?.push?.branches?.includes("master")) continue;
			if (
				cancelInProgressOn("push", workflow.concurrency?.["cancel-in-progress"])
			) {
				findings.push(file);
			}
		}
		expect(
			findings,
			"master-push workflows must let their runs finish",
		).toEqual([]);
	});

	it("keeps edited PR groups distinct without splitting pushed groups", () => {
		// Recurrence #3716: an edit must not cancel the pushed head, while
		// opened, synchronize, and reopened must retain their existing latch.
		const eligible: Array<{ file: string; group: string }> = [];
		for (const file of readdirSync(WORKFLOWS)) {
			if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
			const workflow = loadWorkflow(file);
			const trigger = workflow.on?.pull_request;
			if (
				!trigger?.types?.includes("edited") ||
				!cancelInProgressOn(
					"pull_request",
					workflow.concurrency?.["cancel-in-progress"],
				)
			) {
				continue;
			}
			const group = workflow.concurrency?.group;
			if (typeof group === "string") eligible.push({ file, group });
		}

		assertNonEmptyScan(
			"edited pull-request concurrency workflows",
			eligible.length,
			2,
		);
		const findings = eligible.flatMap(({ file, group }) => {
			const opened = evaluateGroup(group, "opened", "run-opened");
			const synchronize = evaluateGroup(group, "synchronize", "run-sync-a");
			const edited = evaluateGroup(group, "edited", "run-edited");
			return [
				...(synchronize !== evaluateGroup(group, "synchronize", "run-sync-b")
					? [`${file}: synchronize vs synchronize differs`]
					: []),
				...(synchronize === edited
					? [`${file}: synchronize and edited share ${synchronize}`]
					: []),
				...(opened !== synchronize
					? [`${file}: opened and synchronize differ`]
					: []),
			];
		});
		expect(findings, "edited groups must preserve push cancellation").toEqual(
			[],
		);
	});
});
