import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	lintClassSweep,
	lintLocalPrBody,
} from "../../scripts/check-pr-body.mjs";

// #4273: a `## Class sweep` names the defect shape, quotes the search that
// defines its population, and gives a verdict; or it says `none: <reason>`.
// A section that only enumerates the files this PR changed is refused, so the
// population of a shape cannot hide behind the change list (#4248 missed the
// #4268 members this way). The body fixtures are `gh pr view --json body`
// captures, bodies only, of the two real PRs the issue names.
const repositoryRoot = process.cwd();
const readBody = (name: string) =>
	readFileSync(
		join(repositoryRoot, "tests", "fixtures", "ci-pr-bodies", name),
		"utf8",
	);
const pr4248Body = readBody("pr-4248-body.md");
const pr4245Body = readBody("pr-4245-body.md");

describe("Class sweep shape and search (#4273)", () => {
	it("fails #4248's changed-file population with a template pointer", () => {
		const errors = lintClassSweep(pr4248Body);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"## Class sweep"');
		expect(errors[0]).toContain(".github/PULL_REQUEST_TEMPLATE.md");
	});

	it("passes #4245's named shape, quoted search, and per-member verdict", () => {
		expect(lintClassSweep(pr4245Body)).toEqual([]);
	});

	it("accepts none: with a reason", () => {
		expect(
			lintClassSweep(
				"## Class sweep\nnone: docs-only\n\n## Observability\nRecorded.",
			),
		).toEqual([]);
	});

	it.each([
		[
			"no shape",
			"Search: `rg -n foo clients`. The family folds onto the bar seam.",
		],
		[
			"no quoted search",
			"Defect shape: a foo. The family folds onto the bar seam.",
		],
		[
			"no verdict",
			"Defect shape: a foo. Search: `rg -n foo clients`. The changed population is the loader.",
		],
	])("refuses a sweep with %s", (_name, sweep) => {
		expect(
			lintClassSweep(`## Class sweep\n${sweep}\n\n## Observability\nRecorded.`),
		).toHaveLength(1);
	});

	it("reaches the local preflight composition", () => {
		const gitStub = () => "";
		expect(
			lintLocalPrBody(pr4248Body, process.cwd(), gitStub as never).errors.join(
				" ",
			),
		).toContain('"## Class sweep"');
		expect(
			lintLocalPrBody(pr4245Body, process.cwd(), gitStub as never).errors.join(
				" ",
			),
		).not.toContain('"## Class sweep"');
	});
});
