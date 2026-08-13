#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { DETECTOR_ISSUE, defaultFetcher, detectStaleOpenIssues, formatSummary } from "./lib/stale-open-issues.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN/GH_TOKEN are required");
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
const candidates = await detectStaleOpenIssues({ fetcher: defaultFetcher(token), repository });
const summary = formatSummary(candidates, { runUrl });
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (candidates.length > 0) {
	await fetch(`https://api.github.com/repos/${repository}/issues/${DETECTOR_ISSUE}/comments`, {
		method: "POST",
		headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ body: summary }),
	});
}
