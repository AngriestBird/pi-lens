import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// oxlint-disable-next-line no-control-regex -- ANSI is the input being removed.
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const WINDOWS_VITEST_SUMMARY = /^\s*Tests\s+(\d+)\s+failed\b/;

/** Return the failed-test count from a Vitest Windows runner log, if present. */
export function parseWindowsVitestFailureCount(log) {
	for (const line of String(log).split(/\r?\n/).reverse()) {
		const match = line.replace(ANSI_ESCAPE, "").match(WINDOWS_VITEST_SUMMARY);
		if (match) return Number.parseInt(match[1], 10);
	}
	return null;
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
	const count = parseWindowsVitestFailureCount(
		readFileSync(process.argv[2], "utf8"),
	);
	process.stdout.write(count === null ? "unknown\n" : `${count}\n`);
}
