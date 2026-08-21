#!/usr/bin/env node
/**
 * Capture a REAL tool's bytes into a runner-output fixture (#1937).
 *
 * A runner parser written from documentation or memory can be wrong in a way no
 * hand-authored test sees: the test asserts the shape the author imagined, the
 * parser reads that same shape, and both agree while the binary emits something
 * else. #1933 found exactly that in the vale runner — the parser read
 * `Data.Files`, vale emits a flat map, and the runner reported "0 findings"
 * against a CLI that exited 1.
 *
 * This script closes that loop. It spawns a real binary with the SAME argv the
 * runner spawns, then writes stdout, stderr, and the exit code into a fixture
 * envelope with a machine-generated provenance header. The envelope feeds
 * `tests/clients/dispatch/runners/captured-real-output.test.ts`, which replays
 * the bytes through the runner and asserts the parser finds something.
 *
 * The provenance header is generated here, never typed by hand, so a fixture
 * cannot claim a version or a command it did not run.
 *
 * Usage:
 *   node scripts/capture-runner-output.mjs \
 *     --runner actionlint --tool actionlint --bin /path/to/actionlint \
 *     --cwd /tmp/workspace --file .github/workflows/ci.yml \
 *     --case workflow-violations \
 *     -- -format "{{json .}}" .github/workflows/ci.yml
 *
 * Flags:
 *   --runner        registered dispatch runner id the bytes belong to (required)
 *   --tool          binary name as humans know it (default: --runner)
 *   --bin           path/name of the executable to spawn (default: --tool)
 *   --cwd           working directory for the spawn (default: process.cwd())
 *   --file          workspace-relative path the runner was pointed at (required)
 *   --case          fixture basename (default: "real")
 *   --version-args  argv that prints the version (default: --version)
 *   --note          free-text note stored alongside the provenance
 *   --out-dir       fixture root (default: tests/fixtures/runner-output)
 *
 * Everything after `--` is the argv passed to the binary.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/** Placeholder substituted for the capture workspace inside captured bytes. */
export const WORKSPACE_TOKEN = "__WORKSPACE__";

function parseArgs(argv) {
	const opts = {};
	const rest = [];
	let afterSeparator = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (afterSeparator) {
			rest.push(arg);
			continue;
		}
		if (arg === "--") {
			afterSeparator = true;
			continue;
		}
		if (arg.startsWith("--")) {
			opts[arg.slice(2)] = argv[++i];
			continue;
		}
		rest.push(arg);
	}
	return { opts, rest };
}

/**
 * First version-shaped token in a `--version` banner, e.g. "1.7.12" from
 * "actionlint 1.7.12\ninstalled by ...".
 *
 * Returns "" when the banner carries no `major.minor` token. The caller then
 * refuses to write the fixture. Falling back to "the first line" instead would
 * let a failed spawn's error text become the recorded version — a Windows
 * "not compatible with the version of Windows you're running" message did
 * exactly that during this script's own bring-up.
 */
export function extractVersion(banner) {
	const match = (banner ?? "").match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
	return match ? match[0] : "";
}

/**
 * Replace every spelling of `workspace` in `text` with WORKSPACE_TOKEN.
 *
 * Tools print the workspace path back in their output, and that path is the
 * capturing machine's temp dir. Left raw, a fixture would be unreplayable on
 * another host and would leak a local path into the repo. Both the native and
 * the forward-slash spelling are replaced because a single tool emits both
 * (Windows argv in, POSIX-normalised paths out).
 */
export function redactWorkspace(text, workspace) {
	if (!text || !workspace) return text ?? "";
	const backslashed = workspace.replace(/\//g, "\\");
	const spellings = new Set([
		// Longest first. A tool's `--format json` output embeds the path with
		// DOUBLED backslashes; the raw spelling does not match it, and JSON
		// output is exactly what these fixtures capture. Replacing a shorter
		// spelling first would break the escaped one into unmatchable pieces.
		backslashed.replace(/\\/g, "\\\\"),
		workspace,
		workspace.replace(/\\/g, "/"),
		backslashed,
	]);
	let out = text;
	for (const spelling of spellings) {
		out = out.split(spelling).join(WORKSPACE_TOKEN);
	}
	return out;
}

/**
 * Whether this spawn needs a shell.
 *
 * On Windows an npm-installed tool is a `.cmd` shim that `spawnSync` cannot
 * exec directly, so those need `shell: true`. A real `.exe` does NOT: routing it
 * through cmd.exe re-tokenises the argv and silently drops the quoting that
 * arguments like `{{json .}}` depend on, which turns a capture into a usage
 * error instead of tool output.
 */
export function needsShell(bin, platform = process.platform) {
	if (platform !== "win32") return false;
	return !/\.exe$/i.test(bin);
}

/** Quote one argv entry for cmd.exe, which sees a single concatenated string. */
export function quoteForShell(arg) {
	return /[\s"{}^&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function spawnCaptured(bin, args, cwd, shellOverride) {
	const shell = shellOverride ?? needsShell(bin);
	return spawnSync(bin, shell ? args.map(quoteForShell) : args, {
		cwd,
		encoding: "utf8",
		shell,
		maxBuffer: 32 * 1024 * 1024,
	});
}

function main() {
	const { opts, rest } = parseArgs(process.argv.slice(2));
	const runner = opts.runner;
	const file = opts.file;
	if (!runner || !file) {
		console.error("--runner and --file are required");
		process.exit(2);
	}
	const tool = opts.tool ?? runner;
	const bin = opts.bin ?? tool;
	const cwd = path.resolve(opts.cwd ?? process.cwd());
	const caseName = opts.case ?? "real";
	const versionArgs = (opts["version-args"] ?? "--version").split(/\s+/);
	const outDir = path.resolve(
		opts["out-dir"] ?? path.join(repoRoot, "tests/fixtures/runner-output"),
	);

	const shellOverride =
		opts.shell === undefined ? undefined : opts.shell === "true";
	const versionRun = spawnCaptured(bin, versionArgs, cwd, shellOverride);
	const version = extractVersion(
		`${versionRun.stdout ?? ""}${versionRun.stderr ?? ""}`,
	);
	if (!version) {
		console.error(
			`could not read a version from \`${bin} ${versionArgs.join(" ")}\` — refusing to write a fixture with no provenance`,
		);
		process.exit(2);
	}

	const run = spawnCaptured(bin, rest, cwd, shellOverride);
	if (run.error) {
		console.error(`spawn failed: ${run.error.message}`);
		process.exit(2);
	}

	const envelope = {
		provenance: {
			runner,
			tool,
			version,
			command: [tool, ...rest].join(" "),
			workspace: path
				.relative(repoRoot, opts.workspace ? path.resolve(opts.workspace) : cwd)
				.replace(/\\/g, "/"),
			platform: `${process.platform}-${process.arch}`,
			capturedAt: new Date().toISOString().slice(0, 10),
			...(opts.note ? { note: opts.note } : {}),
		},
		file,
		exitCode: run.status,
		stdout: redactWorkspace(run.stdout ?? "", cwd),
		stderr: redactWorkspace(run.stderr ?? "", cwd),
	};

	const dest = path.join(outDir, runner, `${caseName}.captured.json`);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, `${JSON.stringify(envelope, null, "\t")}\n`, "utf8");
	console.log(
		`captured ${tool} ${version} → ${path.relative(repoRoot, dest)} (exit ${run.status}, ${envelope.stdout.length}B stdout, ${envelope.stderr.length}B stderr)`,
	);
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	main();
}
