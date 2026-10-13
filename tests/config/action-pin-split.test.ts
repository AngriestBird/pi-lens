import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ActionPin,
	parseActionPins,
	workflowFiles,
} from "../../scripts/check-action-pins.mjs";

// Recurrence #4350: the combined dependabot merge #4333 bumped
// github/codeql-action/analyze and /upload-sarif to v4.38.3 and left /init on
// v4.38.2, in both ci.yml and codeql.yml. Dependabot treats each subpath of an
// action repo as its own dependency, so it can bump them in separate PRs.
// CodeQL refuses a mixed run ("All steps in a workflow that use
// github/codeql-action must use the same version"), and every CodeQL job
// failed in the analyze post-step. The per-file codeql-workflow test compared
// ci.yml with codeql.yml step by step, so a split both files shared passed it.
//
// The rule is one SHA per action repository (owner/repo) across the whole
// tree that scripts/check-action-pins.mjs reads, not only codeql-action: it
// held for every other repository when it landed, and a subpath action such
// as actions/cache/restore + actions/cache/save splits the same way.

const ROOT = resolve(import.meta.dirname, "../..");

const repoOf = (action: string) => action.split("/").slice(0, 2).join("/");

function pinSplits(pins: ActionPin[]): string[] {
	const byRepo = new Map<string, Map<string, string[]>>();
	for (const pin of pins) {
		const repo = repoOf(pin.action);
		const shas = byRepo.get(repo) ?? new Map<string, string[]>();
		byRepo.set(repo, shas);
		const sites = shas.get(pin.sha) ?? [];
		shas.set(pin.sha, sites);
		sites.push(`${pin.file}:${pin.line}`);
	}
	return [...byRepo]
		.filter(([, shas]) => shas.size > 1)
		.map(
			([repo, shas]) =>
				`${repo} has ${shas.size} SHAs: ${[...shas]
					.map(([sha, sites]) => `${sha} at ${sites.join(", ")}`)
					.join("; ")}`,
		);
}

async function treePins(): Promise<ActionPin[]> {
	const files = await workflowFiles(ROOT);
	return files.flatMap((file) =>
		parseActionPins(readFileSync(file, "utf8"), relative(ROOT, file)),
	);
}

describe("#4350 one SHA per action repository across the workflow tree", () => {
	it("pins every action repository, codeql-action included, to one SHA", async () => {
		const pins = await treePins();
		// Floor: the tree still holds the three codeql-action steps in both
		// workflows, so an empty walk or a parser change cannot pass vacuously.
		const codeql = pins.filter(
			(pin) => repoOf(pin.action) === "github/codeql-action",
		);
		expect(new Set(codeql.map((pin) => pin.action))).toEqual(
			new Set([
				"github/codeql-action/init",
				"github/codeql-action/analyze",
				"github/codeql-action/upload-sarif",
			]),
		);
		expect(new Set(codeql.map((pin) => pin.file))).toEqual(
			new Set([".github/workflows/ci.yml", ".github/workflows/codeql.yml"]),
		);
		expect(pinSplits(pins)).toEqual([]);
	});

	it("reports a subpath split within one repository and not across repositories", () => {
		const a = "2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2";
		const b = "24c54180a607b1449ed407dd24f251e4e9147c8d";
		const pins = [
			...parseActionPins(
				[
					`      - uses: actions/checkout@${a} # v7`,
					`      - uses: github/codeql-action/init@${a} # v4.38.2`,
					`      - uses: github/codeql-action/analyze@${b} # v4.38.3`,
				].join("\n"),
				"ci.yml",
			),
			...parseActionPins(
				[
					`      - uses: actions/setup-node@${b} # v6.5.0`,
					`      - uses: github/codeql-action/upload-sarif@${b} # v4.38.3`,
				].join("\n"),
				"codeql.yml",
			),
		];
		expect(pinSplits(pins)).toEqual([
			`github/codeql-action has 2 SHAs: ${a} at ci.yml:2; ${b} at ci.yml:3, codeql.yml:2`,
		]);
	});
});
