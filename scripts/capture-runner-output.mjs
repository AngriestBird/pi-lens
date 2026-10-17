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
 *     --probe '["--version"]' \
 *     --clean-content 'on: push\n' \
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
 *   --probe         JSON array: the argv the runner's availability checker
 *                   sends. Repeatable. REQUIRED: the replay answers that exact
 *                   spawn from this record, so a fixture without one cannot be
 *                   replayed against the real checker (#4473).
 *   --clean-content the bytes of a clean input for this invocation
 *   --clean-file    workspace-relative path to write them to (default:
 *                   "clean" plus the analysed file's extension)
 *   --merge-into    existing fixture envelope: merge the availability and clean
 *                   records into it instead of writing a new capture. This is
 *                   the retrofit path for fixtures captured before #4473, and it
 *                   never touches the recorded work bytes.
 *   --note          free-text note stored alongside the provenance
 *   --out-dir       fixture root (default: tests/fixtures/runner-output)
 *
 * Everything after `--` is the argv passed to the binary.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
 * `text` with the capture host's home directory collapsed to `~`.
 *
 * A tool's probe output can name its own install path (swiftlint reports the
 * shim it loaded, and that path is under this host's home). The record keeps the
 * tool's answer but never a maintainer's absolute path.
 */
export function redactHomePath(text) {
	const home = os.homedir();
	if (!text || !home) return text ?? "";
	return text.split(home).join("~");
}

/**
 * The argv to spawn: every `WORKSPACE_TOKEN` in an argument becomes the
 * workspace, so `__WORKSPACE__/bad.fish` is that file's absolute path (#4454).
 *
 * A runner that hands its tool an ABSOLUTE path (helm lint `<chart root>`) can
 * only be captured by spawning with the workspace's absolute path, while the
 * recorded argv must stay machine-neutral. The token stands for the workspace
 * in the recorded argv, and the replay maps it back to its own temp dir.
 */
export function expandWorkspaceArgs(argv, workspace) {
	return argv.map((arg) => arg.split(WORKSPACE_TOKEN).join(workspace));
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

/** Characters that force an argv entry to be quoted before cmd.exe sees it. */
const NEEDS_QUOTING = /[\s"{}^&|<>()%!]/;

/**
 * Quote one argv entry for a Windows command line.
 *
 * Implements the CommandLineToArgvW rules rather than "escape the quotes"
 * (#1937 round 2): backslashes are literal EXCEPT before a double quote, where
 * 2n backslashes produce n backslashes and a delimiting quote, and 2n+1
 * produce n backslashes and a literal quote. The previous version escaped `"`
 * and left `\` alone, so an argument ending in a backslash — a Windows
 * directory path, routinely — had its closing quote escaped and swallowed the
 * next argument. CodeQL flags that shape as incomplete sanitization, correctly.
 *
 * Written as a scan rather than chained regex replaces so there is one pass
 * over the string and no ordering hazard between the two escapes.
 */
export function quoteForShell(arg) {
	const text = String(arg);
	if (text.length > 0 && !NEEDS_QUOTING.test(text)) return text;

	let quoted = '"';
	let pendingBackslashes = 0;
	for (const character of text) {
		if (character === "\\") {
			pendingBackslashes++;
			continue;
		}
		if (character === '"') {
			// Double the run, then escape the quote itself.
			quoted += `${"\\".repeat(pendingBackslashes * 2 + 1)}"`;
			pendingBackslashes = 0;
			continue;
		}
		quoted += `${"\\".repeat(pendingBackslashes)}${character}`;
		pendingBackslashes = 0;
	}
	// A trailing run abuts the closing quote, so it must be doubled too.
	quoted += `${"\\".repeat(pendingBackslashes * 2)}"`;
	return quoted;
}

/**
 * The executable path as the shell should see it.
 *
 * `shell: true` hands the path to a shell, and which shell that is depends on
 * the environment: cmd.exe normally, but `sh` when the run started from Git
 * Bash. `sh` reads each `\` in `C:\tools\phpstan.bat` as an escape and hands
 * the program `C:toolsphpstan.bat`. Windows accepts forward slashes in a path,
 * and no shell treats them specially, so normalise before quoting.
 */
export function shellBinPath(bin) {
	return quoteForShell(String(bin).replace(/\\/g, "/"));
}

/**
 * One availability record: the argv the runner's checker sends, the binary that
 * answered, and the REAL exit status with its streams.
 *
 * The exit status is the load-bearing field. helm 4 rejects `--version` and
 * exits 1; a record that dropped the status would let the replay assume a
 * rejected probe succeeded, which is the class #4473 names.
 */
export function buildAvailability(command, argv, version, run) {
	return {
		command,
		argv: [...argv],
		version: version ?? "",
		exitCode: typeof run?.status === "number" ? run.status : null,
		stdout: redactHomePath(run?.stdout ?? ""),
		stderr: redactHomePath(run?.stderr ?? ""),
	};
}

/**
 * Merge the availability and clean records into an existing fixture envelope.
 *
 * The work bytes, provenance, file and exit code stay byte-identical: those were
 * captured from the version the fixture names, and re-recording them from a
 * newer build would silently retarget the parser evidence. Only the records the
 * old capture could not produce are added.
 */
export function mergeRecords(dest, patch) {
	const envelope = JSON.parse(fs.readFileSync(dest, "utf8"));
	if (patch.availability) envelope.availability = patch.availability;
	if (patch.clean) envelope.clean = patch.clean;
	if (patch.cleanUnavailable)
		envelope.cleanUnavailable = patch.cleanUnavailable;
	if (patch.versionArgv) {
		envelope.provenance = {
			...envelope.provenance,
			versionArgv: patch.versionArgv,
		};
	}
	fs.writeFileSync(dest, `${JSON.stringify(envelope, null, "\t")}\n`, "utf8");
	return envelope;
}

function spawnCaptured(bin, args, cwd, shellOverride) {
	const shell = shellOverride ?? needsShell(bin);
	return spawnSync(
		shell ? shellBinPath(bin) : bin,
		shell ? args.map(quoteForShell) : args,
		{
			cwd,
			encoding: "utf8",
			shell,
			maxBuffer: 32 * 1024 * 1024,
		},
	);
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

	// The probe set is required, not defaulted: the replay answers the checker's
	// exact spawn from this record, so a capture that omits it writes a fixture
	// nothing can replay against a real checker (#4473).
	// A probe is either the bare argv (`["--version"]`, command = --tool) or
	// `{command, argv}` when the checker spawns something other than the tool
	// (markdownlint's checker is `markdownlint-cli2`).
	const probes = [];
	for (let i = 0; i < process.argv.length; i++) {
		if (process.argv[i] !== "--probe") continue;
		let parsed;
		try {
			parsed = JSON.parse(process.argv[i + 1]);
		} catch {
			console.error("--probe needs JSON, e.g. --probe '[\"--version\"]'");
			process.exit(2);
		}
		const probe = Array.isArray(parsed)
			? { command: tool, argv: parsed }
			: { command: parsed?.command ?? tool, argv: parsed?.argv };
		if (
			typeof probe.command !== "string" ||
			probe.command.length === 0 ||
			!Array.isArray(probe.argv) ||
			probe.argv.some((token) => typeof token !== "string")
		) {
			console.error(
				"--probe needs either a JSON array of strings or {command, argv}",
			);
			process.exit(2);
		}
		probes.push(probe);
	}
	if (probes.length === 0) {
		console.error(
			"--probe is required: the capture records the real tool's answer to the availability probe its runner sends (#4473)",
		);
		process.exit(2);
	}

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

	const availability = probes.map((probe) =>
		buildAvailability(
			probe.command,
			probe.argv,
			version,
			spawnCaptured(bin, probe.argv, cwd, shellOverride),
		),
	);

	// The clean run: the SAME invocation in a workspace where the analysed
	// input is clean. The argv is not rewritten — it is the invocation the
	// fixture records — only the directory it runs in changes, so the bytes are
	// evidence about this runner asking this tool for this file's verdict.
	let clean;
	let cleanUnavailable;
	if (opts["clean-unavailable"]) {
		if (opts["clean-cwd"]) {
			console.error("--clean-unavailable and --clean-cwd are exclusive");
			process.exit(2);
		}
		cleanUnavailable = String(opts["clean-unavailable"]);
		if (cleanUnavailable.trim().length < 20) {
			console.error(
				"--clean-unavailable needs a fact about the tool, not a placeholder",
			);
			process.exit(2);
		}
	} else if (opts["clean-cwd"]) {
		const cleanCwd = path.resolve(opts["clean-cwd"]);
		const cleanFile = opts["clean-file"] ?? file;
		const cleanRun = spawnCaptured(
			bin,
			expandWorkspaceArgs(rest, cleanCwd),
			cleanCwd,
			shellOverride,
		);
		if (cleanRun.error) {
			console.error(`clean spawn failed: ${cleanRun.error.message}`);
			process.exit(2);
		}
		if (cleanRun.status !== 0) {
			console.error(
				`the clean run exited ${cleanRun.status}, so it is not clean — refusing to record it. Output:\n${cleanRun.stdout ?? ""}${cleanRun.stderr ?? ""}`,
			);
			process.exit(2);
		}
		clean = {
			workspace: (
				opts["clean-workspace"] ?? path.relative(repoRoot, cleanCwd)
			).replace(/\\/g, "/"),
			file: cleanFile,
			argv: rest,
			version,
			exitCode: cleanRun.status,
			stdout: redactHomePath(
				redactWorkspace(redactWorkspace(cleanRun.stdout ?? "", cwd), cleanCwd),
			),
			stderr: redactHomePath(
				redactWorkspace(redactWorkspace(cleanRun.stderr ?? "", cwd), cleanCwd),
			),
		};
	} else if (opts["clean-file"] !== undefined) {
		console.error("--clean-file needs --clean-cwd");
		process.exit(2);
	}

	const records = {
		availability,
		...(clean ? { clean } : {}),
		...(cleanUnavailable ? { cleanUnavailable } : {}),
		versionArgv: versionArgs,
	};

	if (opts["merge-into"]) {
		const dest = path.resolve(opts["merge-into"]);
		const merged = mergeRecords(dest, records);
		console.log(
			`merged ${availability.length} availability record(s)${clean ? " and the clean run" : ""} into ${path.relative(repoRoot, dest)}`,
		);
		for (const record of merged.availability) {
			console.log(
				`  ${record.command} ${JSON.stringify(record.argv)} → exit ${record.exitCode} (${record.version})`,
			);
		}
		return;
	}

	const run = spawnCaptured(
		bin,
		expandWorkspaceArgs(rest, cwd),
		cwd,
		shellOverride,
	);
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
			// The argv as an ARRAY as well as a string. The string is for
			// humans; splitting it back on whitespace is lossy for a quoted
			// argument like `{{json .}}`, and the argv-tie assertion in
			// runners/captured-real-output.test.ts needs the exact tokens in
			// the exact order to notice a runner's invocation drifting.
			argv: rest,
			versionArgv: versionArgs,
			workspace: path
				.relative(repoRoot, opts.workspace ? path.resolve(opts.workspace) : cwd)
				.replace(/\\/g, "/"),
			platform: `${process.platform}-${process.arch}`,
			capturedAt: new Date().toISOString().slice(0, 10),
			...(opts.note ? { note: opts.note } : {}),
		},
		availability,
		...(clean ? { clean } : {}),
		...(cleanUnavailable ? { cleanUnavailable } : {}),
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
