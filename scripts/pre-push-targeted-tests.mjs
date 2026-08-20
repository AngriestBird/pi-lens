#!/usr/bin/env node
// scripts/pre-push-targeted-tests.mjs (#1804)
//
// Runs a targeted vitest selection before a push: a build, then the test
// files that plausibly cover the changed .ts files. Never the full suite —
// the suite is machine-wide-locked (#1101) and CI is authoritative.
//
// Selection is two passes over `tests/**/*.test.ts`:
//   1. Path mirror: a changed `clients/foo/bar.ts` selects a test file whose
//      basename is `bar.test.ts` (the repo's dominant tests/ layout mirrors
//      clients/).
//   2. Content grep: a changed file's basename appears in a test file's own
//      import specifiers — catches shared-seam siblings the path mirror
//      misses (tests/index-*-wiring.test.ts import shared modules by name,
//      not by mirrored path; see AGENTS.md's "sibling test files encode the
//      same behavior" note).
// A changed test file is always included directly.
//
// If nothing matches (docs-only / non-.ts changes), this builds only and
// skips the test run — never silently skips the build too.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function resolveDiffRange() {
	const stdin = readStdin().trim();
	if (stdin) {
		const firstLine = stdin.split("\n")[0]?.trim();
		const parts = firstLine ? firstLine.split(/\s+/) : [];
		const [, localSha, , remoteSha] = parts;
		if (localSha && remoteSha && !/^0+$/.test(remoteSha)) {
			return `${remoteSha}...${localSha}`;
		}
	}
	// New branch (no remote tracking ref yet) or unreadable stdin: diff
	// against origin/master, same baseline CI compares PRs against.
	return "origin/master...HEAD";
}

function changedTsFiles(range) {
	try {
		const out = execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8" });
		return out
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.endsWith(".ts") && !line.startsWith("dist/"));
	} catch (error) {
		console.warn(
			`[pre-push] could not compute diff range "${range}", falling back to a build-only pass: ${error instanceof Error ? error.message : error}`,
		);
		return null;
	}
}

function collectTestFiles(dir, out) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectTestFiles(full, out);
		else if (entry.name.endsWith(".test.ts")) out.push(full.split(path.sep).join("/"));
	}
	return out;
}

function selectTargetedTests(changed, allTests) {
	const selected = new Set();
	for (const file of changed) {
		if (file.endsWith(".test.ts")) {
			if (existsSync(file)) selected.add(file.split(path.sep).join("/"));
			continue;
		}
		const base = path.basename(file, ".ts");
		for (const test of allTests) {
			if (path.basename(test, ".test.ts") === base) selected.add(test);
		}
	}
	for (const file of changed) {
		if (file.endsWith(".test.ts")) continue;
		const base = path.basename(file, ".ts");
		const marker = `/${base}`;
		for (const test of allTests) {
			if (selected.has(test)) continue;
			let content;
			try {
				content = readFileSync(test, "utf8");
			} catch {
				continue;
			}
			if (content.includes(`${marker}"`) || content.includes(`${marker}'`) || content.includes(`${marker}.js`)) {
				selected.add(test);
			}
		}
	}
	return [...selected];
}

function runInherit(command, args) {
	execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
}

function main() {
	const range = resolveDiffRange();
	const changed = changedTsFiles(range);

	console.log("[pre-push] building...");
	runInherit("npm", ["run", "build"]);

	if (changed === null || changed.length === 0) {
		console.log("[pre-push] no TypeScript changes to target; build-only pass complete.");
		return;
	}

	const allTests = collectTestFiles("tests", []);
	const selected = selectTargetedTests(changed, allTests);

	if (selected.length === 0) {
		console.log(
			`[pre-push] no test files matched ${changed.length} changed .ts file(s); build-only pass complete.`,
		);
		return;
	}

	console.log(
		`[pre-push] running ${selected.length} targeted test file(s) for ${changed.length} changed .ts file(s):`,
	);
	for (const test of selected) console.log(`  - ${test}`);
	runInherit(process.execPath, ["scripts/with-test-lock.mjs", "--", "vitest", "run", ...selected]);
}

main();
