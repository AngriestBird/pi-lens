import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	lintLocalPrBody,
	lintPullRequestEvent,
} from "../../scripts/check-pr-body.mjs";

// #4774: a bot that edits a PR body appends its block after the author's last
// section, and `## Fold check` is the template's last section. Greptile's
// "Last reviewed commit" link quotes a commit title that ends `(refs #N)`, so
// the check read `#N` as a candidate with no decision (PR 4767, run
// 39863184911). The rule under test: the body ends at the first top-level
// HTML comment after the last heading the template names, so any bot's block
// is cut, a marker nobody listed included. Every case goes through a
// production entry (`lintPullRequestEvent`, CI's, and `lintLocalPrBody`, the
// preflight's); only the GitHub fetch at the process boundary is a double.

const fixture = (name: string) =>
	readFileSync(
		new URL(`../fixtures/pr-body-bot-blocks/${name}`, import.meta.url),
		"utf8",
	);
const GREPTILE = "<!-- greptile_comment -->";
const full4767 = fixture("4767.body.txt");
const authored4767 = full4767.slice(0, full4767.indexOf(GREPTILE));
const FOLD_REFUSAL = 'PR body "## Fold check" must decide each candidate';

describe("a bot block appended to the body never counts (#4774)", () => {
	beforeEach(() => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	async function ci(text: string) {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockImplementation(async (url: string) =>
				String(url).includes("/files")
					? new Response("[]", { status: 200 })
					: new Response(JSON.stringify({ body: text }), { status: 200 }),
			);
		const result = await lintPullRequestEvent(
			fetchImpl,
			{ pull_request: { number: 4767, body: text } },
			() => "",
		);
		const printed = errors.mock.calls.flat().join("\n");
		errors.mockClear();
		return { result, printed };
	}
	const local = (text: string) =>
		lintLocalPrBody(text, process.cwd(), (() => "") as never).errors.join("\n");

	// Acceptance 1 and 2. Recurrence: PR 4767 at 7f7ee1127, whose body ends with
	// Greptile's block quoting `(refs #43...`.
	it("passes CI's entry for the #4767 body with Greptile's block", async () => {
		const { result, printed } = await ci(full4767);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
	});

	it("passes the local preflight for the #4767 body with Greptile's block", () => {
		expect(local(full4767)).not.toContain(FOLD_REFUSAL);
	});

	// Acceptance 3. The cut must not swallow a real defect: an undecided `#N`
	// line in the author's own Fold check still refuses, block or no block.
	it("still refuses a real undecided candidate line before the block", async () => {
		const undecided = full4767.replace(
			"- #3875 not folded:",
			"- #3875 landed on master and this branch merged it. Also #3875 not folded:",
		);
		expect(undecided).not.toBe(full4767);
		const { result, printed } = await ci(undecided);
		expect(printed).toContain(FOLD_REFUSAL);
		expect(result.valid).toBe(false);
		expect(local(undecided)).toContain(FOLD_REFUSAL);
	});

	// The admission rule names no bot. Recurrence it prevents: a fix that
	// listed `<!-- greptile_comment -->` would leave the next bot's marker (a
	// planted one here, nobody's list) reading as the author's text.
	it("cuts a block behind a marker no list holds", async () => {
		const planted = `${authored4767}\n\n<!-- unplanned-bot:v9 -->\n\nLast reviewed commit: [fix thing (refs #4999)](https://example.test/c/1)\n`;
		const { result, printed } = await ci(planted);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
		expect(local(planted)).not.toContain(FOLD_REFUSAL);
	});

	// CodeRabbit's block (captured from PR 4680) opens with another marker and
	// holds a markdown heading; the cut sits before the marker, not before the
	// heading, so the heading cannot hide the block from the rule.
	it("cuts CodeRabbit's block, marker and markdown heading included", async () => {
		const block = fixture("4680.coderabbit-block.txt").replace(
			"Improved CI handling",
			"Improved CI handling (refs #4999)",
		);
		expect(block).toContain("## Summary by CodeRabbit");
		const text = `${authored4767}\n\n\n${block}`;
		const { result, printed } = await ci(text);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
	});

	it("cuts the block of a CRLF body", async () => {
		const { result, printed } = await ci(full4767.replace(/\n/g, "\r\n"));
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
	});

	// The author's own comment stays. Recurrence it prevents: PRs 4563 and 4584
	// open with `<!-- ORCHESTRATOR SUMMARY ... -->`, and a cut at the first
	// comment would drop all their sections.
	it("keeps an author comment that a template heading follows", async () => {
		const withTop = `<!-- ORCHESTRATOR SUMMARY\nlane 4774, one note\n-->\n\n${full4767}`;
		const { result, printed } = await ci(withTop);
		expect(printed).not.toContain("is missing");
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
	});

	it("keeps a comment before a later review-round section", async () => {
		const round = `${authored4767}\n\n<!-- note for the reviewer -->\n\n## Review round 1\nThe round fixed the cited finding.\n\n${GREPTILE}\n#4999 quoted by the bot\n`;
		const { printed } = await ci(round);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(printed).not.toContain("is missing");
	});

	// A `<!--` inside a fence is quoted text, not the start of a block.
	it("does not cut at a comment quoted in a fence", async () => {
		const quoted = full4767.replace(
			"- #3875 not folded:",
			"```html\n<!-- quoted -->\n```\n\n- #3875 not folded:",
		);
		expect(quoted).not.toBe(full4767);
		const { result, printed } = await ci(quoted);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
	});
});
