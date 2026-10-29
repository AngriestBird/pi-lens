import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	lintLocalPrBody,
	lintPullRequestEvent,
	referencedIssues,
	resolveBugReferenced,
} from "../../scripts/check-pr-body.mjs";

// Recurrence (#4968): the detection audit of 2026-10-29 found 24 bug-linked PRs
// merged in one week with no `## Detection` section, because each said
// `Refs #N` where the lint only read `Closes`/`Fixes`/`Resolves`. #4769 and
// #4808 were p2 external-bug fixes with no lesson recorded. The rule is keyed
// on the issue's LABEL (`bug`, `nightly-drift`), not on the keyword, and it
// refuses where it cannot read the label or cannot parse the reference.
//
// Closing-PR behaviour is unchanged and pinned by the #4288 suites in
// check-pr-body.test.ts; this file owns the reference-only seam.
const base = (summary: string, tail = "") =>
	[
		"## Why",
		"The body gate records the detection lesson.",
		"",
		"## Notes for the reviewer",
		"None.",
		"",
		"## Change outline",
		"- scripts/check-pr-body.mjs",
		"",
		"## Summary",
		summary,
		"",
		"## Tests",
		"Targeted tests pass.",
		"",
		"## Blast radius",
		"No runtime module touched.",
		"",
		"## Class sweep",
		'Defect shape: a gate keyed on the keyword. Search: `rg -n "bugClosing" scripts`. Verdict: stay specific.',
		"",
		"## Fold check",
		"none: the search listed no candidate",
		"",
		"## Observability",
		"No new failure path; no record added.",
		tail,
	].join("\n");
const detection = (shape = "new: stale mirror", enforcer = "#4439") =>
	`\n## Detection\n\nCaught by: external user\nShould have been caught by: CI unit\nGap: none: no layer would have seen it\nShape: ${shape}\nEnforcer: ${enforcer}\n`;
const refsOnly = base("Fixes the reader. Refs #4321 for the rest.");
const noGit = (() => "") as never;

describe("referencedIssues (#4968)", () => {
	it.each([
		["Refs #12", [12]],
		["refs: #12", [12]],
		["REFS #12, #13 and #14", [12, 13, 14]],
		["- **Refs** #12", [12]],
		["> Refs #12", [12]],
		["Fixes #12", [12]],
		["Resolved GH-12", [12]],
		["Ref #12", [12]],
		// A wrapped reference: the keyword or a trailing comma ends the line.
		["Otherwise Refs\n#12 and the rest.", [12]],
		["Refs #11,\n#12", [11, 12]],
		["Refs #11, #13 and\n#12", [11, 13, 12]],
		["Refs #11.\n#12 is unrelated.", [11]],
		["The fix (refs: [#12](https://example.test/i/12)) lands.", [12]],
		["Landed with refs - #12.", [12]],
		["Landed with **refs** **#12**.", [12]],
		["References #12", [12]],
		["Refs the audit in #12", [12]],
		["The change (refs #12) lands here.", [12]],
		["See Refs #12 and #13 and Closes #14", [12, 13, 14]],
		["No keyword mentions #12 here.", []],
		["```\nRefs #12\n```", []],
		["Use `Refs #12` for a remainder.", []],
		["Refs the template placeholder #NNN", []],
		// Recurrence: PR 4641 opened a bullet with the verb "Fix" and linked a
		// review comment; a URL after the keyword's own span is prose.
		[
			"- Fix round 1 answers review [F1](https://github.com/o/r/pull/9#issuecomment-1).",
			[],
		],
	])("reads %j as %j", (text, expected) => {
		expect(referencedIssues(text)).toEqual({
			issues: expected,
			unrecognised: [],
		});
	});

	// A form the reader cannot turn into this repository's `#N` is returned for
	// the gate to refuse, never skipped (fails closed).
	it.each([
		["Refs owner/repo#12", "owner/repo#12"],
		[
			"Refs: https://github.com/o/r/issues/12",
			"https://github.com/o/r/issues/12",
		],
		["Closes https://github.com/o/r/pull/9", "https://github.com/o/r/pull/9"],
		// A link destination behind the keyword is still a reference.
		[
			"Refs [the bug](https://github.com/o/r/issues/12).",
			"https://github.com/o/r/issues/12",
		],
		["Refs\nowner/repo#12", "owner/repo#12"],
		// The destination reached through a definition, and mid-line.
		[
			"Refs [the bug][1]\n\n[1]: https://github.com/o/r/issues/12",
			"https://github.com/o/r/issues/12",
		],
		[
			"Landed (refs [the bug](https://github.com/o/r/issues/12)).",
			"https://github.com/o/r/issues/12",
		],
	])("returns %j as unrecognised", (text, token) => {
		expect(referencedIssues(text)).toEqual({
			issues: [],
			unrecognised: [token],
		});
	});
});

describe("resolveBugReferenced (#4968)", () => {
	const labelFetch = (names: string[]) =>
		vi
			.fn()
			.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({ labels: names.map((name) => ({ name })) }),
						{ status: 200 },
					),
			);
	beforeEach(() => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	});
	afterEach(() => vi.unstubAllEnvs());

	it.each([["bug"], ["nightly-drift"]])(
		"is true for a %s label",
		async (name) => {
			expect(await resolveBugReferenced(refsOnly, labelFetch([name]))).toBe(
				true,
			);
		},
	);

	it("is false for a label that is neither", async () => {
		expect(
			await resolveBugReferenced(refsOnly, labelFetch(["enhancement"])),
		).toBe(false);
	});

	it("is false and never fetches when nothing is referenced", async () => {
		const fetchImpl = vi.fn();
		expect(await resolveBugReferenced(base("A plain change."), fetchImpl)).toBe(
			false,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("reads only the issues the body does not close", async () => {
		const fetchImpl = labelFetch(["enhancement"]);
		await resolveBugReferenced(base("Closes #11. Refs #12."), fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(String(fetchImpl.mock.calls[0][0])).toContain("/issues/12");
	});

	it("is null on a failed read", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("denied", { status: 500 }));
		expect(await resolveBugReferenced(refsOnly, fetchImpl)).toBe(null);
	});

	it("is null with no API credentials", async () => {
		vi.stubEnv("GITHUB_TOKEN", "");
		expect(await resolveBugReferenced(refsOnly, labelFetch(["bug"]))).toBe(
			null,
		);
	});

	it("is null for a reference form it cannot read, without fetching", async () => {
		const fetchImpl = labelFetch(["enhancement"]);
		expect(
			await resolveBugReferenced(base("Refs owner/repo#12."), fetchImpl),
		).toBe(null);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("ignores a reference behind a bot block", async () => {
		const fetchImpl = labelFetch(["bug"]);
		const text = `${base("A plain change.")}\n\n<!-- greptile -->\nLast reviewed commit (refs #77)\n`;
		expect(await resolveBugReferenced(text, fetchImpl)).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("a PR that only references a bug issue (#4968)", () => {
	const eventFetch = (labels: string[] | "fail", text: string) =>
		vi.fn().mockImplementation(async (url: string) => {
			if (String(url).includes("/files"))
				return new Response(JSON.stringify([]), { status: 200 });
			if (String(url).includes("/issues/"))
				return labels === "fail"
					? new Response("denied", { status: 500 })
					: new Response(
							JSON.stringify({ labels: labels.map((name) => ({ name })) }),
							{ status: 200 },
						);
			return new Response(JSON.stringify({ body: text }), { status: 200 });
		});
	const runEvent = async (text: string, labels: string[] | "fail") => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await lintPullRequestEvent(
				eventFetch(labels, text),
				{ pull_request: { number: 4968, body: text } },
				() => "",
			);
			return {
				result,
				errors: errors.mock.calls.flat().join("\n"),
				warnings: warnings.mock.calls.flat().join("\n"),
			};
		} finally {
			errors.mockRestore();
			warnings.mockRestore();
		}
	};
	beforeEach(() => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		vi.stubEnv("GITHUB_ACTIONS", "true");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("CI reds a Refs-only bug body that has no Detection section", async () => {
		const run = await runEvent(refsOnly, ["bug"]);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain('missing "## Detection"');
	});

	it("CI reds a nightly-drift reference too", async () => {
		const run = await runEvent(refsOnly, ["nightly-drift"]);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain('missing "## Detection"');
	});

	it("CI passes a Refs-only bug body with a complete Detection section", async () => {
		const run = await runEvent(`${refsOnly}\n${detection()}`, ["bug"]);
		expect(run.errors).toBe("");
		expect(run.result.valid).toBe(true);
	});

	// The audit's blank and absent Shape/Enforcer lines (#4860, #4863 had none;
	// #4771 a stub name): each reds on the reference seam like on a closing PR.
	it.each([
		["a blank Shape", detection("", "#4439")],
		["an unnamed new Shape", detection("new:", "#4439")],
		["a blank Enforcer", detection("new: stale mirror", "")],
		[
			"no Shape or Enforcer line",
			"\n## Detection\n\nCaught by: dogfood\nShould have been caught by: this layer\nGap: none: docs only\n",
		],
	])("CI reds %s on a Refs-only bug body", async (_name, section) => {
		const run = await runEvent(`${refsOnly}\n${section}`, ["bug"]);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain('"## Detection"');
	});

	it("CI refuses an unknown answer on a referenced bug", async () => {
		const run = await runEvent(
			`${refsOnly}\n${detection("new: stale mirror", "#4439").replace("external user", "unknown")}`,
			["bug"],
		);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain("not a detection lesson");
	});

	it("CI passes a Refs-only body for a non-bug issue", async () => {
		const run = await runEvent(refsOnly, ["enhancement"]);
		expect(run.result.valid).toBe(true);
	});

	it("CI refuses when the referenced label cannot be read", async () => {
		const run = await runEvent(refsOnly, "fail");
		expect(run.result.valid).toBe(false);
		expect(run.errors).toMatch(/#4321.*could not be read/s);
	});

	it("CI refuses a reference form it cannot resolve", async () => {
		const run = await runEvent(base("Refs owner/repo#12."), ["enhancement"]);
		expect(run.result.valid).toBe(false);
		expect(run.errors).toContain("owner/repo#12");
	});

	// The closing path is unchanged: an unreadable closed-issue label still
	// warns and skips (#4288), so a closing-only PR is not newly refused.
	it("CI keeps warn-and-skip for an unreadable closed issue", async () => {
		const run = await runEvent(base("Closes #4321."), "fail");
		expect(run.result.valid).toBe(true);
		expect(run.warnings).toContain("could not read the closed issue label");
	});
});

describe("the local preflight reads a referenced bug (#4968)", () => {
	it("reds a Refs-only body whose reference is a bug", () => {
		const result = lintLocalPrBody(refsOnly, process.cwd(), noGit, {
			bugClosing: false,
			bugReferenced: true,
		});
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('missing "## Detection"');
	});

	it("passes a Refs-only body with a complete Detection section", () => {
		const result = lintLocalPrBody(
			`${refsOnly}\n${detection()}`,
			process.cwd(),
			noGit,
			{ bugClosing: false, bugReferenced: true },
		);
		expect(result.errors).toEqual([]);
	});

	it("passes a Refs-only body for a non-bug reference", () => {
		const result = lintLocalPrBody(refsOnly, process.cwd(), noGit, {
			bugClosing: false,
			bugReferenced: false,
		});
		expect(result.errors).toEqual([]);
	});

	it("refuses when the referenced label is unreadable", () => {
		const result = lintLocalPrBody(refsOnly, process.cwd(), noGit, {
			bugClosing: false,
			bugReferenced: null,
		});
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toMatch(/#4321.*could not be read/s);
	});

	it("refuses when the caller supplies no label reader at all", () => {
		const result = lintLocalPrBody(refsOnly, process.cwd(), noGit, {
			bugClosing: false,
		});
		expect(result.valid).toBe(false);
	});

	it("hands the whole body to an injected reader", () => {
		const resolve = vi.fn().mockReturnValue(false);
		const result = lintLocalPrBody(refsOnly, process.cwd(), noGit, {
			bugClosing: false,
			resolveBugReferenced: resolve,
		});
		expect(resolve).toHaveBeenCalledWith(refsOnly);
		expect(result.errors).toEqual([]);
	});

	it("does not read references when the body already closes a bug", () => {
		const resolve = vi.fn();
		lintLocalPrBody(
			`${base("Closes #4320. Refs #4321.")}\n${detection()}`,
			process.cwd(),
			noGit,
			{ bugClosing: true, resolveBugReferenced: resolve },
		);
		expect(resolve).not.toHaveBeenCalled();
	});
});
