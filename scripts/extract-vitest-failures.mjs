#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { normalizeVitestOutput } from "./lib/vitest-summary.mjs";

/** Return the first Vitest failure block, preserving its diagnostic details. */
export function extractVitestFailureBlock(output) {
	const lines = normalizeVitestOutput(String(output)).split("\n");
	const start = lines.findIndex((line) => /^\s*FAIL\b/.test(line));
	if (start < 0) return "";
	const end = lines.findIndex(
		(line, index) => index > start && /^\s*Test Files\b/.test(line),
	);
	return lines
		.slice(start, end < 0 ? undefined : end)
		.join("\n")
		.trim();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const input = process.argv[2];
	if (!input) throw new Error("usage: extract-vitest-failures.mjs <log>");
	const block = extractVitestFailureBlock(readFileSync(input, "utf8"));
	if (block) process.stdout.write(`${block}\n`);
}
