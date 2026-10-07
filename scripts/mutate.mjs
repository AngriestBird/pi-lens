#!/usr/bin/env node
/**
 * Run one bounded, restorable hand mutation (#4048).
 *
 * The file is deliberately a small process boundary: callers can use it from
 * a shell or a test without importing the test runner or the project build.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
	unlinkSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
	if (message) console.error(`mutate.mjs: ${message}`);
	console.error(
		"usage: scripts/mutate.mjs --file <path> --find <text|/regex/> --replace <text> --tests <files…> [--built] [--table] [--restore]",
	);
	process.exitCode = 2;
}

function argsFrom(argv) {
	const values = { tests: [] };
	let fileSeen = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (
			arg === "--built" ||
			arg === "--table" ||
			arg === "--restore" ||
			arg === "--allow-comment"
		)
			values[arg.slice(2)] = true;
		else if (arg === "--tests") values.tests = argv.slice(++index);
		else if (["--file", "--find", "--replace"].includes(arg)) {
			if (arg === "--file" && fileSeen)
				throw new Error(
					"repeated --file is not supported; provide one file per run",
				);
			if (arg === "--file") fileSeen = true;
			const value = argv[++index];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			values[arg.slice(2)] = value;
		} else throw new Error(`unknown argument ${arg}`);
	}
	if (values.restore) return values;
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

function mutationFor(original, find, replacement, allowComment = false) {
	const needle = parseFind(find);
	const searchable = blankCommentsAndStrings(original);
	const codeIndex =
		typeof needle === "string"
			? searchable.indexOf(needle)
			: (() => {
					needle.lastIndex = 0;
					return needle.exec(searchable)?.index ?? -1;
				})();
	if (codeIndex < 0 && !allowComment)
		throw new Error(
			"refusing no-op edit: --find matches only comments/strings or is absent",
		);
	const originalIndex =
		codeIndex >= 0
			? codeIndex
			: typeof needle === "string"
				? original.indexOf(needle)
				: original.search(needle);
	const matchLength =
		typeof needle === "string"
			? needle.length
			: (() => {
					needle.lastIndex = 0;
					return needle.exec(original.slice(originalIndex))?.[0].length;
				})();
	const mutated =
		originalIndex >= 0 && matchLength !== undefined
			? original.slice(0, originalIndex) +
				replacement +
				original.slice(originalIndex + matchLength)
			: original.replace(needle, replacement);
	if (mutated === original) {
		throw new Error(
			"refusing no-op edit: --find is absent or replacement is identical",
		);
	}
	return mutated;
}

function blankCommentsAndStrings(source) {
	let state = "code";
	let quote = "";
	let escaped = false;
	let output = "";
	for (let index = 0; index < source.length; index += 1) {
		const current = source[index];
		const next = source[index + 1];
		if (state === "line") {
			output += current === "\n" ? "\n" : " ";
			if (current === "\n") state = "code";
			continue;
		}
		if (state === "block") {
			output += current === "\n" ? "\n" : " ";
			if (current === "*" && next === "/") {
				output += " ";
				index += 1;
				state = "code";
			}
			continue;
		}
		if (state === "string") {
			output += current === "\n" ? "\n" : " ";
			if (escaped) escaped = false;
			else if (current === "\\") escaped = true;
			else if (current === quote) state = "code";
			continue;
		}
		if (current === "/" && next === "/") {
			output += "  ";
			index += 1;
			state = "line";
			continue;
		}
		if (current === "/" && next === "*") {
			output += "  ";
			index += 1;
			state = "block";
			continue;
		}
		if (current === '"' || current === "'" || current === "`") {
			output += " ";
			state = "string";
			quote = current;
			continue;
		}
		output += current;
	}
	return output;
}

function restoreFile(file, bytes, expectedHash) {
	writeFileSync(file, bytes);
	const actual = digest(readFileSync(file));
	if (actual !== expectedHash)
		throw new Error(`restore sha256 mismatch for ${file}`);
}

function journalFor(file) {
	return `${file}.mutate-backup`;
}

function journalHashFor(file) {
	return `${journalFor(file)}.sha256`;
}

function writeJournal(file, bytes) {
	writeFileSync(journalFor(file), bytes, { flag: "wx" });
	writeFileSync(journalHashFor(file), digest(bytes), { flag: "wx" });
}

function restoreJournal(file) {
	const backup = journalFor(file);
	const hashFile = journalHashFor(file);
	if (!statExists(backup) || !statExists(hashFile)) return false;
	const bytes = readFileSync(backup);
	const expectedHash = readFileSync(hashFile, "utf8").trim();
	if (digest(bytes) !== expectedHash)
		throw new Error(`backup sha256 mismatch for ${file}`);
	restoreFile(file, bytes, expectedHash);
	unlinkSync(backup);
	unlinkSync(hashFile);
	return true;
}

function journalFiles(directory) {
	const found = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules")
			found.push(...journalFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".mutate-backup"))
			found.push(full.slice(0, -".mutate-backup".length));
	}
	return found;
}

function failedTitles(output) {
	return output
		.split("\n")
		.filter((line) => /FAIL|×|✗/.test(line))
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 20);
}

function classifyTestRun(testRun) {
	if (/(?:Tests\s+no tests|Tests\s+0 tests)/.test(testRun.output))
		return "ERROR";
	return testRun.code === 0 ? "SURVIVED" : "RED";
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
		activeChild = child;
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
			activeChild = null;
			process.removeListener("SIGINT", stop);
			resolve({ code: code ?? 130, signal, output });
		});
	});
}

let activeChild = null;

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
	if (options.restore) {
		const files = options.file
			? [path.resolve(root, options.file)]
			: journalFiles(root);
		let restored = 0;
		for (const file of files) restored += restoreJournal(file) ? 1 : 0;
		console.log(`restored ${restored} mutation journal(s)`);
		return 0;
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
		restoreJournal(file);
		if (!gitClean(path.relative(root, file)))
			throw new Error(`refusing dirty file: ${path.relative(root, file)}`);
	}
	const originals = new Map(files.map((file) => [file, readFileSync(file)]));
	let activeFiles = [];
	let result = { code: 2, failed: [], status: "RED" };
	let interrupted = false;
	let handlingSignal = false;
	const restoreAll = () => {
		for (const [file, bytes] of originals)
			restoreFile(file, bytes, digest(bytes));
		for (const file of activeFiles) {
			if (statExists(journalFor(file))) restoreJournal(file);
		}
	};
	const signalHandler = (signal) => {
		if (handlingSignal) return;
		handlingSignal = true;
		interrupted = true;
		try {
			if (activeChild) activeChild.kill("SIGKILL");
			restoreAll();
		} finally {
			process.removeAllListeners(signal);
			process.kill(process.pid, signal);
		}
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
		process.once(signal, () => signalHandler(signal));
	process.once("uncaughtException", (error) => {
		try {
			restoreAll();
		} finally {
			console.error(error.stack ?? error);
			process.exit(1);
		}
	});
	try {
		const original = originals.get(target);
		for (const [file, bytes] of originals) writeJournal(file, bytes);
		activeFiles = [...originals.keys()];
		writeFileSync(
			target,
			mutationFor(
				original.toString("utf8"),
				options.find,
				options.replace,
				options["allow-comment"],
			),
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
				status: classifyTestRun(testRun),
			};
		}
	} catch (error) {
		result = { code: 1, failed: [error.message], status: "RED" };
	} finally {
		restoreAll();
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
			process.removeAllListeners(signal);
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
