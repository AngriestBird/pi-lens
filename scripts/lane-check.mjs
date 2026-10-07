#!/usr/bin/env node
// One pre-handback gate for delegated lanes (#4047).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "origin/master";

export function classifyFailureFiles(files, verdicts) {
	return files.map((file) => ({
		file,
		verdict: verdicts[file] ?? "INCONCLUSIVE",
	}));
}

export function laneExitCode(classifications) {
	return classifications.some((entry) => entry.verdict === "CAUSED-BY-CHANGE")
		? 1
		: 0;
}

function command(commandName, args, { inherit = false } = {}) {
	const result = spawnSync(commandName, args, {
		cwd: ROOT,
		encoding: "utf8",
		stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
	});
	if (!inherit) {
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
	}
	return result.status ?? 1;
}

function changedFiles() {
	const tracked = gitExecFileSync(["diff", "--name-only", `${BASE}...HEAD`], {
		cwd: ROOT,
		encoding: "utf8",
	});
	const untracked = gitExecFileSync(
		["ls-files", "--others", "--exclude-standard"],
		{ cwd: ROOT, encoding: "utf8" },
	);
	return [
		...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean)),
	].sort();
}

function governanceFiles() {
	const words =
		/(sweep|ratchet|conformance|coverage|gate|governance|silence|hermeticity|invariant|contract)/;
	const clients = readdirSync(path.join(ROOT, "tests/clients"), {
		withFileTypes: true,
	})
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".test.ts") &&
				words.test(entry.name),
		)
		.map((entry) => `tests/clients/${entry.name}`);
	const config = readdirSync(path.join(ROOT, "tests/config"), {
		withFileTypes: true,
	})
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
		.map((entry) => `tests/config/${entry.name}`);
	return [...new Set([...clients, ...config])].sort();
}

function redOnBase(files) {
	const verdicts = {};
	for (const file of files) {
		const result = spawnSync(
			process.execPath,
			["scripts/red-on-base.mjs", file, "--base", BASE],
			{ cwd: ROOT, encoding: "utf8" },
		);
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		process.stdout.write(output);
		verdicts[file] =
			output.match(/VERDICT: (CAUSED-BY-CHANGE|RED-ON-BASE)/)?.[1] ??
			"INCONCLUSIVE";
		console.log(`${verdicts[file]}: ${file}`);
	}
	return verdicts;
}

function capturedCommand(commandName, args) {
	const result = spawnSync(commandName, args, {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	process.stdout.write(output);
	return { status: result.status ?? 1, output };
}

export function main(argv = process.argv.slice(2)) {
	const bodyIndex = argv.indexOf("--body");
	const body = bodyIndex === -1 ? null : argv[bodyIndex + 1];
	const changed = changedFiles();
	const targeted = spawnSync(
		process.execPath,
		["scripts/pre-push-targeted-tests.mjs"],
		{ cwd: ROOT, input: "", encoding: "utf8" },
	);
	const targetedOutput = `${targeted.stdout ?? ""}${targeted.stderr ?? ""}`;
	process.stdout.write(targeted.stdout ?? "");
	process.stderr.write(targeted.stderr ?? "");
	const selected = [
		...targetedOutput.matchAll(/^\s+- (tests\/[^\s]+\.test\.ts)$/gm),
	].map((match) => match[1]);
	const failing = targeted.status === 0 ? [] : [...new Set(selected)];
	const verdicts = redOnBase(failing);
	const governance = governanceFiles();
	console.log(`\n[lane-check] governance batch (${governance.length} files)`);
	const governanceRun = capturedCommand("npm", [
		"run",
		"test:targeted",
		"--",
		...governance,
	]);
	const governanceFailures =
		governanceRun.status === 0
			? []
			: governance.filter((file) => governanceRun.output.includes(file));
	const governanceVerdicts = redOnBase(governanceFailures);
	const bodyStatus = body
		? command(process.execPath, [
				"scripts/check-pr-body.mjs",
				"--lint-local",
				body,
			])
		: 0;
	const changelog = command(process.execPath, [
		"scripts/check-changelog-fragments.mjs",
		"--base",
		BASE,
	]);
	const touched = changed.filter((file) => existsSync(path.join(ROOT, file)));
	const format = touched.length
		? command("npx", ["oxfmt", "--check", ...touched])
		: 0;
	const astgrep = command("npm", ["run", "astgrep:self-scan"]);
	const status = gitExecFileSync(["status", "--porcelain"], {
		cwd: ROOT,
		encoding: "utf8",
	}).trim();
	const trackedHandoff = gitExecFileSync(
		["ls-files", "--", "PR_BODY.md", "COMMIT_MSG.txt", "HANDBACK_4047.md"],
		{ cwd: ROOT, encoding: "utf8" },
	).trim();
	const classifications = classifyFailureFiles(
		[...new Set([...failing, ...governanceFailures])],
		{ ...governanceVerdicts, ...verdicts },
	);
	const record = {
		base: BASE,
		changed: changed.length,
		governance: governance.length,
		failedFiles: classifications,
		checks: {
			governanceStatus: governanceRun.status,
			bodyStatus,
			changelog,
			format,
			astgrep,
		},
		clean: !status && !trackedHandoff,
	};
	console.log(JSON.stringify(record));
	console.log("ORCHESTRATOR SUMMARY");
	console.log(`branch: tools/4047-lane-check`);
	console.log(
		`head: ${gitExecFileSync(["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()}`,
	);
	console.log(
		`red files: ${classifications.length}; CAUSED-BY-CHANGE: ${classifications.filter((x) => x.verdict === "CAUSED-BY-CHANGE").length}`,
	);
	console.log(
		`green checks: ${Object.values(record.checks).filter((x) => x === 0).length}; governance files: ${governance.length}`,
	);
	console.log(`clean status: ${record.clean}`);
	return laneExitCode(classifications);
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
	process.exitCode = main();
