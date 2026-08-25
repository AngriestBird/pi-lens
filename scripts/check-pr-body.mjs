import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";
const REQUIRED_SECTIONS = [
	"Tests",
	"Blast radius",
	"Class sweep",
	"Observability",
];
const HEADING = /^##\s+(.+?)\s*$/;
const FIX_ROUND = /^Fix round\s+\d+$/i;

function sectionMessage(name, detail) {
	return `PR body ${detail} "## ${name}". See ${TEMPLATE_PATH}.`;
}

/** Check the structural PR-body contract. Content is intentionally not judged. */
export function lintPrBody(body = "") {
	const lines = String(body).split(/\r?\n/);
	const headings = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = HEADING.exec(lines[index]);
		if (match) headings.push({ index, name: match[1] });
	}
	const ignoredRanges = headings
		.filter(({ name }) => FIX_ROUND.test(name))
		.map((heading) => ({
			start: heading.index,
			end:
				headings.find((candidate) => candidate.index > heading.index)?.index ??
				lines.length,
		}));
	const isIgnored = (index) =>
		ignoredRanges.some(({ start, end }) => index >= start && index < end);

	const errors = [];
	const summary = headings.find(({ name }) => name === "Summary");
	const firstHeading = headings[0]?.index ?? lines.length;
	if (!summary && !lines.slice(0, firstHeading).some((line) => line.trim())) {
		errors.push(`PR body is missing a Summary section. See ${TEMPLATE_PATH}.`);
	}

	for (const name of REQUIRED_SECTIONS) {
		const heading = headings.find((candidate) => candidate.name === name);
		if (!heading) {
			errors.push(sectionMessage(name, "is missing"));
			continue;
		}
		const nextHeading = headings.find(
			(candidate) =>
				candidate.index > heading.index && !FIX_ROUND.test(candidate.name),
		);
		const content = lines
			.slice(heading.index + 1, nextHeading?.index ?? lines.length)
			.filter((_, offset) => !isIgnored(heading.index + 1 + offset));
		if (!content.some((line) => line.trim())) {
			errors.push(
				sectionMessage(name, "has no content before the next heading"),
			);
		}
	}

	return { valid: errors.length === 0, errors };
}

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}

async function liveBody(repository, number, fallback) {
	try {
		const token = process.env.GITHUB_TOKEN;
		if (!token) throw new Error("GITHUB_TOKEN is not set");
		const response = await fetch(
			`https://api.github.com/repos/${repository}/pulls/${number}`,
			{
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
			`Warning: could not fetch the live PR body; using the event payload instead (${error instanceof Error ? error.message : error}).`,
		);
		return fallback;
	}
}

async function lintPullRequestEvent() {
	const event = eventPayload();
	const pullRequest = event.pull_request;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!pullRequest || !repository)
		throw new Error("Pull request event and GITHUB_REPOSITORY are required");
	const body = await liveBody(
		repository,
		pullRequest.number,
		pullRequest.body ?? "",
	);
	const result = lintPrBody(body);
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
