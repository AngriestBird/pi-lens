// #4053: branch workflow_dispatch runs must not write shared issues, branches,
// releases, registries, or other GitHub state. This census prevents the
// compat/install tracking-issue recurrence and the #4038 literal path bug.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");
const WRITE_GUARD =
	"github.event_name == 'schedule' || github.ref == 'refs/heads/master'";

type Step = {
	name?: unknown;
	if?: unknown;
	run?: unknown;
	with?: Record<string, unknown>;
};
type Job = { if?: unknown; steps?: Step[] };
type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> };

function load(source: string): Workflow {
	return yaml.load(source) as Workflow;
}

// Shell comments are not executable evidence. Keep quoted # characters so a
// command such as `echo "#"` remains code, while a prose mention cannot admit
// a writer or hide one from this census.
function withoutShellComments(source: string): string {
	return source
		.split("\n")
		.map((line) => {
			let quote: "'" | '"' | undefined;
			for (let i = 0; i < line.length; i += 1) {
				const char = line[i];
				if (char === "\\") {
					i += 1;
					continue;
				}
				if ((char === "'" || char === '"') && (!quote || quote === char)) {
					quote = quote ? undefined : char;
					continue;
				}
				if (char === "#" && !quote) return line.slice(0, i);
			}
			return line;
		})
		.join("\n");
}

const WRITER_PATTERNS: Array<[string, RegExp]> = [
	["tracking issue", /(?:node\s+)?scripts\/upsert-tracking-issue\.mjs\b/],
	["gh issue", /\bgh\s+issue\s+(?:create|edit|comment|close)\b/],
	["data branch push", /\bgit\s+push\b/],
	["GitHub release", /\bgh\s+release\s+(?:create|edit|delete)\b/],
	[
		"npm publish",
		/\bnpm\s+publish\b(?![^\n]*--dry-run)|\bnpx\s+[^\n]*\bnpm@[^\n]*\bpublish\b(?![^\n]*--dry-run)/,
	],
	["GitHub label", /\bgh\s+label\s+create\b/],
	[
		"mutating GitHub API",
		/\bgh\s+api\b[^\n]*--method\s+(?:POST|PATCH|PUT|DELETE)\b/,
	],
];

function hasWriteGuard(...conditions: unknown[]): boolean {
	const text = conditions
		.filter((condition): condition is string => typeof condition === "string")
		.join(" ");
	return (
		text.includes(WRITE_GUARD) ||
		// A schedule-only job is an equivalent stricter guard: it cannot be
		// reached by the workflow_dispatch branch path at all.
		/^\s*github\.event_name\s*==\s*['"]schedule['"]\s*$/.test(text)
	);
}

function writerFindings(source: string, workflowPath: string): string[] {
	const workflow = load(source);
	const findings: string[] = [];
	const dispatchable = Object.prototype.hasOwnProperty.call(
		workflow.on ?? {},
		"workflow_dispatch",
	);
	if (!dispatchable) return findings;
	for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
		for (const [stepIndex, step] of (job.steps ?? []).entries()) {
			const run =
				typeof step.run === "string" ? withoutShellComments(step.run) : "";
			const writers = WRITER_PATTERNS.filter(([, pattern]) =>
				pattern.test(run),
			);
			if (writers.length === 0) continue;
			if (!hasWriteGuard(job.if, step.if)) {
				const name =
					typeof step.name === "string" ? step.name : `step ${stepIndex}`;
				for (const [kind] of writers)
					findings.push(
						`${workflowPath}:${jobName}/${name}: ${kind} lacks ref guard`,
					);
			}
		}
	}
	return findings;
}

function withVariableFindings(source: string, workflowPath: string): string[] {
	const workflow = load(source);
	const findings: string[] = [];
	for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
		for (const [stepIndex, step] of (job.steps ?? []).entries()) {
			for (const [key, value] of Object.entries(step.with ?? {})) {
				if (typeof value !== "string") continue;
				if (
					/\$(?!\{\{)(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.test(
						value,
					)
				) {
					const name =
						typeof step.name === "string" ? step.name : `step ${stepIndex}`;
					findings.push(
						`${workflowPath}:${jobName}/${name}: with.${key} uses shell variable`,
					);
				}
			}
		}
	}
	return findings;
}

function allWorkflowFiles(): string[] {
	const files = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));
	assertNonEmptyScan(
		"workflow files walked for writer governance",
		files.length,
		10,
	);
	return files;
}

const SHELL_VARIABLE_FIXTURE = `
jobs:
  fixture:
    steps:
      - name: Bad action input
        uses: actions/upload-artifact@v1
        with:
          path: "$RUNNER_TEMP/report.json"
      - name: Expression input
        uses: actions/upload-artifact@v1
        with:
          path: "\${{ runner.temp }}"
      - name: Comment only
        uses: actions/upload-artifact@v1
        with:
          path: report.json # $RUNNER_TEMP is only a comment
`;

describe("workflow writer governance (#4053)", () => {
	it("lists every writer and rejects an unguarded dispatchable writer", () => {
		const findings = allWorkflowFiles().flatMap((file) =>
			writerFindings(
				readFileSync(resolve(WORKFLOWS, file), "utf8"),
				`.github/workflows/${file}`,
			),
		);
		expect(findings).toEqual([]);
	});

	it("detects shell variables in with inputs but not expressions or comments", () => {
		expect(withVariableFindings(SHELL_VARIABLE_FIXTURE, "fixture.yml")).toEqual(
			["fixture.yml:fixture/Bad action input: with.path uses shell variable"],
		);
	});

	it("rejects a shell variable in a real action input", () => {
		const findings = allWorkflowFiles().flatMap((file) =>
			withVariableFindings(
				readFileSync(resolve(WORKFLOWS, file), "utf8"),
				`.github/workflows/${file}`,
			),
		);
		expect(findings).toEqual([]);
	});
});
