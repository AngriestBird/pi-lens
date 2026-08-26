import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";
const TEMPLATE_FILE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	TEMPLATE_PATH,
);
const REQUIRED_SECTIONS = [
	"Tests",
	"Blast radius",
	"Class sweep",
	"Observability",
];
const HEADING = /^#{2,4}\s+(.+?)\s*$/;

// Fleet census from the review of 11 bodies: ## OBSERVABILITY x5,
// ## what changed x6, ## verification x7, and ## Summary x1. “What changed”
// (with or without “and why”) satisfies Summary; “Verification” satisfies
// Tests. Heading matching is deliberately case-insensitive.
const SECTION_SYNONYMS = new Map([
	["summary", "summary"],
	["problem", "summary"],
	["what changed", "summary"],
	["what changed and why", "summary"],
	["what changed / why", "summary"],
	["what changed / why / verification", ["summary", "tests"]],
	["tests", "tests"],
	["verification", "tests"],
	["blast radius", "blast radius"],
	["class sweep", "class sweep"],
	["observability", "observability"],
	["test assessment", "test assessment"],
]);

function sectionMessage(name, detail) {
	return `PR body ${detail} "## ${name}". See ${TEMPLATE_PATH}.`;
}

function hasSection(heading, section) {
	return Array.isArray(heading?.section)
		? heading.section.includes(section)
		: heading?.section === section;
}

function sourceWithoutFencedBlocks(source) {
	let fenced = false;
	return String(source ?? "")
		.split(/\r?\n/)
		.map((line) => {
			if (/^\s*```/.test(line)) {
				fenced = !fenced;
				return "";
			}
			return fenced ? "" : line;
		})
		.join("\n");
}

function templatePlaceholderLines() {
	const lines = sourceWithoutFencedBlocks(
		readFileSync(TEMPLATE_FILE, "utf8"),
	).split(/\r?\n/);
	const placeholders = new Map();
	let current;
	for (const line of lines) {
		const heading = HEADING.exec(line);
		if (heading) {
			current = SECTION_SYNONYMS.get(heading[1].trim().toLowerCase());
			continue;
		}
		const value = line.trim();
		// Exact placeholder matching is intentionally advisory: paste-and-tweak
		// residuals can evade it when a contributor changes one word.
		if (current && value && !/^[-*+] \[ \]/.test(value)) {
			if (!placeholders.has(current)) placeholders.set(current, new Set());
			placeholders.get(current).add(value);
		}
	}
	return placeholders;
}

function hasRealContent(lines, section, placeholders) {
	const templateLines = placeholders.get(section) ?? new Set();
	return lines.some((line) => {
		const value = line.trim();
		return value && !/^[-*+] \[ \]/.test(value) && !templateLines.has(value);
	});
}

/** Check the structural PR-body contract, including answered sections. */
export function lintPrBody(body = "", options = {}) {
	const rawLines = String(body ?? "").split(/\r?\n/);
	const lines = sourceWithoutFencedBlocks(body).split(/\r?\n/);
	const headings = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = HEADING.exec(lines[index]);
		if (match)
			headings.push({
				index,
				name: match[1],
				level: match[0].match(/^#+/)[0].length,
				section: SECTION_SYNONYMS.get(match[1].trim().toLowerCase()),
			});
	}
	const placeholders = templatePlaceholderLines();
	const errors = [];
	const summary = headings.find((heading) => hasSection(heading, "summary"));
	const firstHeading = headings[0]?.index ?? lines.length;
	const nextSectionHeading = (heading) =>
		headings.find(
			(candidate) =>
				candidate.index > heading.index && candidate.level <= heading.level,
		);
	const summaryEnd = summary
		? (nextSectionHeading(summary)?.index ?? lines.length)
		: 0;
	if (
		(!summary ||
			!hasRealContent(
				lines.slice(summary.index + 1, summaryEnd),
				"summary",
				placeholders,
			)) &&
		!hasRealContent(lines.slice(0, firstHeading), "summary", placeholders)
	) {
		errors.push(`PR body is missing a Summary section. See ${TEMPLATE_PATH}.`);
	}

	// Value discipline (AGENTS.md "Test assessment and removal"): a PR that
	// touches tests/ must say, per touched file, what it uniquely pins and
	// what became redundant. Conditional because docs/production-only PRs owe
	// nothing here.
	const requiredSections = options.requireTestAssessment
		? [...REQUIRED_SECTIONS, "Test assessment"]
		: REQUIRED_SECTIONS;

	for (const name of requiredSections) {
		const heading = headings.find((candidate) =>
			hasSection(candidate, name.toLowerCase()),
		);
		if (!heading) {
			errors.push(sectionMessage(name, "is missing"));
			continue;
		}
		const nextHeading = nextSectionHeading(heading);
		const rawContent = rawLines.slice(
			heading.index + 1,
			nextHeading?.index ?? lines.length,
		);
		if (!hasRealContent(rawContent, name.toLowerCase(), placeholders))
			errors.push(
				sectionMessage(name, "has no content before the next heading"),
			);
	}
	return { valid: errors.length === 0, errors };
}

export async function resolveLivePrBody(
	payloadPr,
	fetchImpl = globalThis.fetch,
) {
	const fallback = payloadPr.body ?? "";
	try {
		const token = process.env.GITHUB_TOKEN;
		if (!token) throw new Error("GITHUB_TOKEN is not set");
		const apiUrl = process.env.GITHUB_API_URL;
		const repository = process.env.GITHUB_REPOSITORY;
		if (!apiUrl || !repository)
			throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
		const response = await fetchImpl(
			`${apiUrl}/repos/${repository}/pulls/${payloadPr.number}`,
			{
				signal: AbortSignal.timeout(10_000),
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
		if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
		const data = await response.json();
		if (typeof data.body !== "string")
			throw new Error("GitHub API returned no body");
		return data.body;
	} catch (error) {
		console.warn(
			`::warning::Could not fetch the live PR body; using the event payload instead (${error instanceof Error ? error.message : error}).`,
		);
		return fallback;
	}
}

/**
 * True when the PR touches any file under tests/. Advisory best-effort: one
 * page of 100 files covers this repo's PR sizes; on any failure (including a
 * PR larger than the page, detected via the Link header) return null so the
 * caller SKIPS the conditional check rather than guessing — a lint that can
 * misfire on fetch trouble teaches people to ignore it.
 */
export async function resolveTouchesTests(payloadPr, fetchImpl = globalThis.fetch) {
	try {
		const token = process.env.GITHUB_TOKEN;
		if (!token) throw new Error("GITHUB_TOKEN is not set");
		const apiUrl = process.env.GITHUB_API_URL;
		const repository = process.env.GITHUB_REPOSITORY;
		if (!apiUrl || !repository)
			throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
		const response = await fetchImpl(
			`${apiUrl}/repos/${repository}/pulls/${payloadPr.number}/files?per_page=100`,
			{
				signal: AbortSignal.timeout(10_000),
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
		if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
		if (/rel="next"/.test(response.headers.get("link") ?? ""))
			throw new Error("PR exceeds one file page; skipping the conditional check");
		const files = await response.json();
		if (!Array.isArray(files)) throw new Error("GitHub API returned no file list");
		return files.some((file) => /^tests\//.test(file.filename ?? ""));
	} catch (error) {
		console.warn(
			`::warning::Could not resolve the PR file list; skipping the Test assessment check (${error instanceof Error ? error.message : error}).`,
		);
		return null;
	}
}

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}

async function lintPullRequestEvent() {
	const pullRequest = eventPayload().pull_request;
	if (!pullRequest || !process.env.GITHUB_REPOSITORY)
		throw new Error("Pull request event and GITHUB_REPOSITORY are required");
	const result = lintPrBody(await resolveLivePrBody(pullRequest), {
		requireTestAssessment:
			(await resolveTouchesTests(pullRequest)) === true,
	});
	if (!result.valid) {
		for (const error of result.errors) console.error(error);
		process.exitCode = 1;
		return;
	}
	console.log(`PR body OK: ${pullRequest.number}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	lintPullRequestEvent().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
