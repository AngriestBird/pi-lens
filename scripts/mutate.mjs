#!/usr/bin/env node
/**
 * Run one bounded, restorable hand mutation (#4048).
 *
 * The file is deliberately a small process boundary: callers can use it from
 * a shell or a test without importing the test runner or the project build.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
	if (message) console.error(`mutate.mjs: ${message}`);
	console.error(
		"usage: scripts/mutate.mjs --file <path> --find <text|/regex/> --replace <text> --tests <files…> [--built] [--table]",
	);
	process.exitCode = 2;
}

function argsFrom(argv) {
	const values = { tests: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--built" || arg === "--table") values[arg.slice(2)] = true;
		else if (arg === "--tests") values.tests = argv.slice(++index);
		else if (["--file", "--find", "--replace"].includes(arg)) {
			const value = argv[++index];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			values[arg.slice(2)] = value;
		} else throw new Error(`unknown argument ${arg}`);
	}
	if (
		!values.file ||
		values.find === undefined ||
		values.replace === undefined
	) {
		throw new Error("--file, --find, and --replace are required");
	}
	if (values.tests.length === 0)
		throw new Error("--tests needs at least one file");
	return values;
}

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function gitClean(file) {
	const result = spawnSync(
		process.env.GIT ?? "git",
		["status", "--porcelain=v1", "--", file],
		{
			cwd: root,
			encoding: "utf8",
		},
	);
	if (result.error) throw result.error;
	return result.status === 0 && result.stdout.trim() === "";
}

function twinFor(source) {
	if (source.endsWith(".ts") || source.endsWith(".tsx")) {
		return source.replace(/\.tsx?$/, ".js");
	}
	return null;
}

function parseFind(value) {
	if (value.startsWith("/") && value.lastIndexOf("/") > 0) {
		const slash = value.lastIndexOf("/");
		try {
			return new RegExp(value.slice(1, slash), value.slice(slash + 1));
		} catch (error) {
			throw new Error(`invalid --find regex: ${error.message}`);
		}
	}
	return value;
}

function mutationFor(original, find, replacement) {
	const needle = parseFind(find);
	const mutated = original.replace(needle, replacement);
	if (mutated === original) {
		throw new Error(
			"refusing no-op edit: --find is absent or replacement is identical",
		);
	}
	return mutated;
}

function restoreFile(file, bytes, expectedHash) {
	writeFileSync(file, bytes);
	const actual = digest(readFileSync(file));
	if (actual !== expectedHash)
		throw new Error(`restore sha256 mismatch for ${file}`);
}

function failedTitles(output) {
	return output
		.split("\n")
		.filter((line) => /FAIL|×|✗/.test(line))
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 20);
}

function runTests(files, onSignal) {
	return new Promise((resolve) => {
		const command = path.join(root, "node_modules", ".bin", "vitest");
		const child = spawn(
			command,
			["run", ...files, "--configLoader", "runner"],
			{
				cwd: root,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
			process.stdout.write(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
			process.stderr.write(chunk);
		});
		const stop = () => {
			child.kill("SIGINT");
			onSignal();
		};
		process.once("SIGINT", stop);
		child.once("close", (code, signal) => {
			process.removeListener("SIGINT", stop);
			resolve({ code: code ?? 130, signal, output });
		});
	});
}

function build() {
	const result = spawnSync(
		process.execPath,
		[
			path.join(root, "node_modules", "typescript", "bin", "tsc"),
			"--project",
			"tsconfig.build.json",
		],
		{ cwd: root, env: process.env, encoding: "utf8", stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`build failed with exit code ${result.status}`);
}

function appendTable(options, result) {
	const row = `| ${options.file} | ${result.code} | ${result.status} | ${result.failed.length ? result.failed.join(" ") : "—"} |\n`;
	const body = path.join(root, "PR_BODY.md");
	if (options.table && statExists(body))
		writeFileSync(body, `${readFileSync(body, "utf8")}${row}`);
	console.log(`mutation-table: ${row.trimEnd()}`);
}

function statExists(file) {
	try {
		statSync(file);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	let options;
	try {
		options = argsFrom(process.argv.slice(2));
	} catch (error) {
		usage(error.message);
		return 2;
	}
	const source = path.resolve(root, options.file);
	const target = options.built ? source : source;
	const candidateTwin = options.built ? null : twinFor(source);
	const twin =
		candidateTwin && statExists(candidateTwin) ? candidateTwin : null;
	const files = [target, ...(twin ? [twin] : [])];
	for (const file of files) {
		if (!statExists(file))
			throw new Error(`file does not exist: ${path.relative(root, file)}`);
		if (!gitClean(path.relative(root, file)))
			throw new Error(`refusing dirty file: ${path.relative(root, file)}`);
	}
	const originals = new Map(files.map((file) => [file, readFileSync(file)]));
	let result = { code: 2, failed: [], status: "RED" };
	let interrupted = false;
	const interrupt = () => {
		interrupted = true;
	};
	process.once("SIGINT", interrupt);
	try {
		const original = originals.get(target);
		writeFileSync(
			target,
			mutationFor(original.toString("utf8"), options.find, options.replace),
		);
		if (!options.built) build();
		if (interrupted)
			result = { code: 130, failed: ["interrupted"], status: "RED" };
		else {
			const testRun = await runTests(options.tests, () => {
				interrupted = true;
			});
			result = {
				code: testRun.code,
				failed: failedTitles(testRun.output),
				status: testRun.code === 0 ? "SURVIVED" : "RED",
			};
		}
	} catch (error) {
		result = { code: 1, failed: [error.message], status: "RED" };
	} finally {
		process.removeListener("SIGINT", interrupt);
		for (const [file, bytes] of originals)
			restoreFile(file, bytes, digest(bytes));
	}
	console.log("--- mutation transcript ---");
	console.log(
		`mutation: ${options.file} (${options.find} -> ${options.replace})`,
	);
	console.log(`exit code: ${result.code}`);
	console.log(
		`failed test titles: ${result.failed.length ? result.failed.join("; ") : "none"}`,
	);
	console.log(result.status);
	appendTable(options, result);
	return result.code;
}

main().then((code) => {
	process.exitCode = code;
});
