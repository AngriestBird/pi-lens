#!/usr/bin/env node
// CI entry point for the merge-train warden (#1844). See
// scripts/lib/merge-train-warden.mjs for the decision logic and
// .github/workflows/merge-train-warden.yml for the schedule.

import { appendFileSync } from "node:fs";
import { runWarden } from "./lib/merge-train-warden.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN/GH_TOKEN are required");
const [owner, repo] = repository.split("/");

const fetcher = (url, init) =>
  fetch(url, {
    ...init,
    headers: { ...init?.headers, authorization: `Bearer ${token}` },
  });

const results = await runWarden({ fetcher, owner, repo });

const lines = [`Merge-train warden: swept ${results.length} open PR(s).`];
for (const r of results) {
  if (r.applied.length === 0 && r.errors.length === 0) continue;
  lines.push(`- #${r.number} (${r.mergeStateStatus}) ${r.url}`);
  if (r.applied.length > 0) lines.push(`  applied: ${r.applied.join(", ")}`);
  if (r.errors.length > 0) lines.push(`  ERRORS: ${r.errors.join("; ")}`);
}
if (lines.length === 1) lines.push("No PR needed a warden action this run.");
const summary = lines.join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

const hadErrors = results.some((r) => r.errors.length > 0);
if (hadErrors) process.exitCode = 1;
