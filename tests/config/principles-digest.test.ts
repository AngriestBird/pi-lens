/**
 * The AGENTS.md principles digest points at the vendored file by anchor
 * (#4565).
 *
 * Recurrence: Greptile's custom context carried a pasted copy of the
 * engineering principles (`custom-context?memory=instruction-0`), so its
 * review threads cited rules the repo file had already reworded. Two copies
 * drift, and nothing read the pasted one. The digest names each principle in
 * one line and links the vendored file's own heading, so a renamed heading
 * reds here instead of leaving every link dead.
 *
 * The scan reads comment-and-code-blanked markdown: a link quoted in an HTML
 * comment, a fence or an inline code span is an example, not a digest entry.
 * `stripSource` does not apply to markdown (no string literals), so the
 * comment half of the detector rule is `blankMarkdown` and inline code spans
 * are blanked here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { blankMarkdown } from "../../scripts/lib/defect-shapes.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const AGENTS_PATH = process.env.PI_LENS_AGENTS_PATH
	? path.resolve(process.env.PI_LENS_AGENTS_PATH)
	: path.join(REPO_ROOT, "AGENTS.md");
const PRINCIPLES_PATH = process.env.PI_LENS_PRINCIPLES_PATH
	? path.resolve(process.env.PI_LENS_PRINCIPLES_PATH)
	: path.join(REPO_ROOT, "docs/engineering-principles.md");

/** The sentence that opens the digest in AGENTS.md "How to use this file". */
const DIGEST_INTRO = "The principles, one line each";

/** The statement that makes the vendored copy authoritative. */
const VENDORED_WINS = "vendored file wins on any difference";

/** A digest link to a heading of the vendored principles file. */
const PRINCIPLES_LINK =
	/\[(?<text>[^\]]*)\]\((?<file>docs\/engineering-principles\.md)#(?<anchor>[^)\s]+)\)/g;

/**
 * GitHub's heading anchor: lowercase, punctuation dropped, whitespace runs to
 * one hyphen. Letters and digits keep their Unicode form, as GitHub's slugger
 * does.
 */
export function headingSlug(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s+/g, "-");
}

/** Anchors of every ATX heading in `markdown`, read code-blanked. */
export function headingAnchors(markdown: string): Set<string> {
	const blanked = blankInlineCode(blankMarkdown(markdown));
	return new Set(
		[...blanked.matchAll(/^#{1,6}[ \t]+(?<text>.+?)[ \t]*$/gm)].map((match) =>
			headingSlug(match.groups?.text ?? ""),
		),
	);
}

/** Blank inline code spans, which carry examples rather than live links. */
export function blankInlineCode(markdown: string): string {
	// Line by line, so one unpaired backtick cannot blank the rest of the file.
	return markdown
		.split("\n")
		.map((line) =>
			line.replace(/(`+)(?!`)[^`]*?\1/g, (span) => " ".repeat(span.length)),
		)
		.join("\n");
}

/** The digest block of AGENTS.md, from its intro sentence to the next tag. */
export function digestBlock(agentsMarkdown: string): string {
	// Read blanked from the start: the intro sentence also appears inside the
	// HTML comment of a worked example, and a comment's link is not an entry.
	const blanked = blankInlineCode(blankMarkdown(agentsMarkdown));
	const start = blanked.indexOf(DIGEST_INTRO);
	if (start < 0) return "";
	const rest = blanked.slice(start);
	const end = rest.search(/^</m);
	return end < 0 ? rest : rest.slice(0, end);
}

/** Every principle link in `block`: its label and the anchor it targets. */
export function principlesLinks(
	block: string,
): Array<{ text: string; anchor: string }> {
	return [...block.matchAll(PRINCIPLES_LINK)].map((match) => ({
		text: match.groups?.text ?? "",
		anchor: match.groups?.anchor ?? "",
	}));
}

const agents = fs.readFileSync(AGENTS_PATH, "utf8");
const principles = fs.readFileSync(PRINCIPLES_PATH, "utf8");

describe("AGENTS.md principles digest (#4565)", () => {
	it("links every digest line to a heading the vendored file has", () => {
		const block = digestBlock(agents);
		expect(block, `no digest block: ${DIGEST_INTRO}`).not.toBe("");
		const anchors = headingAnchors(principles);
		expect(anchors.size).toBeGreaterThan(0);
		const links = principlesLinks(block);
		// Two-way: a link whose heading vanished, and a heading with no link, both
		// read as drift between the digest and the vendored file.
		const missing = links
			.filter((link) => !anchors.has(link.anchor))
			.map((link) => `${link.text} -> #${link.anchor}`);
		expect(
			missing,
			`digest links no heading of docs/engineering-principles.md: ${missing.join(", ")}; anchors there: ${[...anchors].join(", ")}`,
		).toEqual([]);
		expect(links.length).toBeGreaterThanOrEqual(12);
	});

	it("gives every digest line one principles link", () => {
		const block = digestBlock(agents);
		const bullets = [...block.matchAll(/^- /gm)].length;
		expect(bullets).toBeGreaterThanOrEqual(12);
		expect(principlesLinks(block)).toHaveLength(bullets);
	});

	it("states that the vendored file wins on any difference", () => {
		expect(digestBlock(agents)).toContain(VENDORED_WINS);
	});

	it("ignores a link quoted in a comment or an inline code span", () => {
		// Recurrence: the self-excuse direction. A pasted example must never
		// satisfy the digest.
		const quoted = [
			"<!--",
			`${DIGEST_INTRO}, quoted.`,
			"- Link ([§1](docs/engineering-principles.md#gone))",
			"-->",
			`${DIGEST_INTRO}, linked.`,
			"- Link ([§1](docs/engineering-principles.md#1-building))",
			"- Quoted `[§2](docs/engineering-principles.md#gone)`",
			"",
		].join("\n");
		expect(principlesLinks(digestBlock(quoted))).toEqual([
			{ text: "§1", anchor: "1-building" },
		]);
	});
});

describe("headingSlug (#4565)", () => {
	it.each([
		["1. Building", "1-building"],
		["3. Reviewing and delegating", "3-reviewing-and-delegating"],
		["4. Honesty and records", "4-honesty-and-records"],
		[
			"Design shared state once, at design time",
			"design-shared-state-once-at-design-time",
		],
		["`TLA+` and config", "tla-and-config"],
		["Fixture adopts an ancestor root", "fixture-adopts-an-ancestor-root"],
	])("slugs %s as %s", (heading, slug) => {
		expect(headingSlug(heading)).toBe(slug);
	});

	it("reads anchors from the vendored file's real headings", () => {
		// Derived independently of the scan: the four sections the digest cites.
		const anchors = headingAnchors(principles);
		expect(anchors.has("1-building")).toBe(true);
		expect(anchors.has("2-testing")).toBe(true);
		expect(anchors.has("4-honesty-and-records")).toBe(true);
		expect(anchors.has("no-such-heading")).toBe(false);
	});
});
