import { describe, expect, it } from "vitest";
import {
	classifyWorkflowEdit,
	evaluateWorkflowRunEvidence,
	readWorkflowTriggers,
} from "../../scripts/lib/workflow-run-evidence.mjs";

// #3085 gap 1. Recurrence: #3033 edited install-smoke steps that only ran on
// master pushes (#3043). The job-level reachability sweep cannot see a
// workflow FILE whose edit no pull request executes; these cases drive the
// file-level classifier and the evidence rule on one fixture per shape.
const FILE = ".github/workflows/stryker-nightly.yml";
const wf = (on: string) =>
	`name: x\non:\n${on}\njobs:\n  a:\n    runs-on: ubuntu-latest\n`;

describe("classifyWorkflowEdit: which edits a pull request executes (#3085)", () => {
	const notExecuting: Array<[string, string, string, boolean]> = [
		[
			"schedule plus workflow_dispatch (the stryker-nightly shape)",
			wf("  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch:"),
			"no pull_request trigger",
			true,
		],
		[
			"push only, no dispatch",
			wf("  push:\n    branches: [master]"),
			"no pull_request trigger",
			false,
		],
		[
			"pull_request_target only (the greetings shape)",
			wf("  pull_request_target:\n    types: [opened]\n  workflow_dispatch:"),
			"pull_request_target",
			true,
		],
		[
			"pull_request paths filter excluding the file itself",
			wf("  pull_request:\n    paths:\n      - 'src/**'\n  workflow_dispatch:"),
			"`paths:` filter excludes",
			true,
		],
		[
			"pull_request paths-ignore matching the file itself",
			wf("  pull_request:\n    paths-ignore: ['.github/**']"),
			"`paths-ignore:` filter matches",
			false,
		],
		[
			"pull_request paths negating the file",
			wf(
				"  pull_request:\n    paths:\n      - '.github/**'\n      - '!.github/workflows/stryker-nightly.yml'",
			),
			"`paths:` filter excludes",
			false,
		],
		[
			"pull_request types that never fire on a push",
			wf("  pull_request:\n    types: [labeled, closed]"),
			"`types:` list",
			false,
		],
		[
			"a flow-mapping on: this reader does not parse (fail closed)",
			"on: {pull_request: {branches: [master]}}\njobs: {}\n",
			"could not be read",
			true,
		],
		[
			"an alias of an anchor that was never defined (fail closed)",
			wf("  pull_request:\n    paths: *missing"),
			"filters could not be read",
			false,
		],
		[
			"an aliased paths list that excludes the file",
			wf(
				"  push:\n    paths: &p\n      - 'src/**'\n  pull_request:\n    paths: *p",
			),
			"`paths:` filter excludes",
			false,
		],
		[
			"pull_request with a flow-mapping filter (fail closed)",
			wf("  pull_request: {paths: ['.github/**']}"),
			"filters could not be read",
			false,
		],
		["no on: block at all", "name: x\njobs: {}\n", "could not be read", true],
	];
	it.each(notExecuting)("%s", (_name, text, reason, dispatchable) => {
		const verdict = classifyWorkflowEdit(text, FILE);
		expect(verdict).toMatchObject({ executes: false, dispatchable });
		expect((verdict as { reason: string }).reason).toContain(reason);
	});

	const executing: Array<[string, string]> = [
		["a mapping pull_request", wf("  pull_request:\n    branches: [master]")],
		["the inline list spelling", "on: [push, pull_request]\njobs: {}\n"],
		["the scalar spelling", "on: pull_request\njobs: {}\n"],
		["the block-list spelling", "on:\n  - push\n  - pull_request\njobs: {}\n"],
		[
			"a paths filter naming the file (install-smoke shape)",
			wf(
				"  pull_request:\n    paths:\n      - '.github/workflows/stryker-nightly.yml'",
			),
		],
		[
			"a paths filter whose list sits at the key's indent",
			wf("  pull_request:\n    paths:\n    - '.github/workflows/*.yml'"),
		],
		[
			"a paths filter as a flow list",
			wf("  pull_request:\n    paths: ['.github/**']"),
		],
		[
			"an anchored push paths list aliased by pull_request (install-smoke shape)",
			wf(
				"  push:\n    paths: &p\n      - '.github/workflows/stryker-nightly.yml'\n  pull_request:\n    paths: *p",
			),
		],
		[
			"a types list with synchronize (ci-infra-kill-rerun shape)",
			wf("  pull_request:\n    types: [synchronize]"),
		],
		[
			"trailing comments and quoted on:",
			`name: x\n"on": # triggers\n  pull_request: # PRs\n    paths: [".github/**"] # self\njobs: {}\n`,
		],
	];
	it.each(executing)("an edit executes on %s", (_name, text) => {
		expect(classifyWorkflowEdit(text, FILE)).toEqual({ executes: true });
	});

	it("reads the pull_request_target and dispatch names a mapping declares", () => {
		const triggers = readWorkflowTriggers(
			wf(
				"  pull_request_target:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 3 * * *'",
			),
		);
		expect([...(triggers?.keys() ?? [])]).toEqual([
			"pull_request_target",
			"workflow_dispatch",
			"schedule",
		]);
	});
});

describe("evaluateWorkflowRunEvidence: the quoted branch run (#3085)", () => {
	const text = wf("  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch:");
	const run = (
		body: string,
		changedFiles: string[] = [FILE],
		files: Record<string, string | null> = {},
	) =>
		evaluateWorkflowRunEvidence({
			changedFiles,
			body,
			readWorkflow: (file) => (file in files ? files[file] : text),
		});

	it("reds an edit with no quoted run", () => {
		const errors = run("## Tests\nTargeted tests pass.");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(FILE);
		expect(errors[0]).toContain(
			"gh workflow run stryker-nightly.yml --ref <branch>",
		);
	});

	it("passes a fenced command followed by its run id", () => {
		const body =
			"```text\n$ gh workflow run stryker-nightly.yml --ref test/x\n✓ Created workflow_dispatch event\nhttps://github.com/o/r/actions/runs/12345678901\n```";
		expect(run(body)).toEqual([]);
	});

	it("passes a `run id` line and the full workflow path", () => {
		expect(
			run(
				"gh workflow run .github/workflows/stryker-nightly.yml --ref b\nrun id: 98765432101",
			),
		).toEqual([]);
	});

	it("reds the command with no run id", () => {
		expect(run("gh workflow run stryker-nightly.yml --ref b")).toHaveLength(1);
	});

	it("reds a run id with no command", () => {
		expect(
			run("see https://github.com/o/r/actions/runs/12345678901"),
		).toHaveLength(1);
	});

	it("reds the command without --ref", () => {
		expect(
			run(
				"gh workflow run stryker-nightly.yml\nhttps://github.com/o/r/actions/runs/12345678901",
			),
		).toHaveLength(1);
	});

	it("reds a run id beyond the window of the command", () => {
		const filler = Array.from({ length: 12 }, () => "unrelated").join("\n");
		expect(
			run(
				`gh workflow run stryker-nightly.yml --ref b\n${filler}\nhttps://github.com/o/r/actions/runs/12345678901`,
			),
		).toHaveLength(1);
	});

	it("reds evidence for a different workflow of the same name prefix", () => {
		expect(
			run(
				"gh workflow run stryker-nightly.yml.bak --ref b\nhttps://github.com/o/r/actions/runs/12345678901",
			),
		).toHaveLength(1);
	});

	it("does not accept evidence hidden in an HTML comment", () => {
		expect(
			run(
				"<!-- gh workflow run stryker-nightly.yml --ref b\nhttps://github.com/o/r/actions/runs/12345678901 -->",
			),
		).toHaveLength(1);
	});

	it("passes a declared-unaffected line with a reason, reds one without", () => {
		expect(
			run(
				"Workflow run unaffected: stryker-nightly.yml \u2014 comment-only edit.",
			),
		).toEqual([]);
		expect(
			run("Workflow run unaffected: stryker-nightly.yml \u2014"),
		).toHaveLength(1);
		expect(
			run("Workflow run unaffected: other.yml \u2014 comment-only edit."),
		).toHaveLength(1);
	});

	it("asks for a workflow_dispatch trigger when the file has none", () => {
		const errors = run("nothing", [FILE], { [FILE]: wf("  push:") });
		expect(errors[0]).toContain("no workflow_dispatch trigger");
	});

	it("requires evidence per changed workflow, not one for all", () => {
		const other = ".github/workflows/compat-smoke.yml";
		const body =
			"gh workflow run stryker-nightly.yml --ref b\nhttps://github.com/o/r/actions/runs/12345678901";
		const errors = run(body, [FILE, other]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(other);
	});

	it("skips a deleted workflow, a pull_request workflow and a non-workflow path", () => {
		expect(run("x", [FILE], { [FILE]: null })).toEqual([]);
		expect(run("x", [FILE], { [FILE]: wf("  pull_request:") })).toEqual([]);
		expect(
			run("x", [
				"scripts/stryker-nightly.yml",
				".github/workflows/sub/x.yml",
				".github/workflows/README.md",
			]),
		).toEqual([]);
	});
});
