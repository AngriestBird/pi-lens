/**
 * Unit tests for the capture primitive behind the real-bytes fixtures (#1937).
 *
 * The script writes the provenance header every runner-output fixture is
 * trusted on, so its own helpers need to be right: a version it cannot read
 * must stop the capture, a workspace path must not leak into the repo, and an
 * argument must survive cmd.exe intact.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildAvailability,
	expandWorkspaceArgs,
	extractVersion,
	mergeRecords,
	needsShell,
	quoteForShell,
	redactWorkspace,
	WORKSPACE_TOKEN,
} from "../../scripts/capture-runner-output.mjs";

describe("extractVersion", () => {
	it("takes the first major.minor token out of a banner", () => {
		expect(extractVersion("actionlint 1.7.12\ninstalled by download")).toBe(
			"1.7.12",
		);
		expect(extractVersion("vale version 3.9.6")).toBe("3.9.6");
		expect(extractVersion("mypy 2.3.1 (compiled: yes)")).toBe("2.3.1");
	});

	// The capture refuses to write a fixture when this returns "". Falling back
	// to "the first line" once recorded a Windows "not compatible with the
	// version of Windows you're running" error AS the tool version.
	it("returns empty for a banner with no version token", () => {
		expect(extractVersion("")).toBe("");
		expect(extractVersion("this program cannot be run")).toBe("");
		expect(
			extractVersion(
				"This version of ktlint.exe is not compatible with the version of Windows you're running.",
			),
		).toBe("");
	});
});

describe("redactWorkspace", () => {
	it("replaces the native, posix, and backslash spellings", () => {
		const workspace = "C:\\Temp\\ws";
		expect(redactWorkspace("at C:\\Temp\\ws\\bad.toml", workspace)).toBe(
			`at ${WORKSPACE_TOKEN}\\bad.toml`,
		);
		expect(redactWorkspace("at C:/Temp/ws/bad.toml", workspace)).toBe(
			`at ${WORKSPACE_TOKEN}/bad.toml`,
		);
	});

	// The JSON-escaped spelling is the one that matters: `--format json` output
	// embeds `C:\\Temp\\ws`, which the raw spelling never matches. Missing it
	// left a local absolute path inside committed fixtures, and the replay then
	// spliced back an invalid JSON escape.
	it("replaces the JSON-escaped spelling", () => {
		const redacted = redactWorkspace(
			'{"file":"C:\\\\Temp\\\\ws\\\\bad.php"}',
			"C:\\Temp\\ws",
		);
		expect(redacted).toBe(`{"file":"${WORKSPACE_TOKEN}\\\\bad.php"}`);
		expect(redacted).not.toContain("Temp");
	});

	it("is a no-op without a workspace", () => {
		expect(redactWorkspace("text", "")).toBe("text");
	});
});

// Recurrence: helm-lint (#4453) hands helm an ABSOLUTE chart root, so a capture
// that spawned `helm lint .` recorded an argv the runner never sends and the
// replay argv tie could not hold. The token lets a manifest entry spawn with the
// workspace's absolute path while the recorded argv stays machine-neutral.
describe("expandWorkspaceArgs", () => {
	it("spawns with the workspace where the manifest wrote the token", () => {
		expect(
			expandWorkspaceArgs(["lint", WORKSPACE_TOKEN], "/tmp/pi-lens-capture-x"),
		).toEqual(["lint", "/tmp/pi-lens-capture-x"]);
	});

	// Recurrence: fish 3.3.1 spells an absolute argv path differently from a
	// relative one, and only a capture spawned with the absolute path holds the
	// bytes production receives (#4454).
	it("expands the token inside an argument, as an absolute file path", () => {
		expect(
			expandWorkspaceArgs([`${WORKSPACE_TOKEN}/bad.fish`], "/tmp/w"),
		).toEqual(["/tmp/w/bad.fish"]);
	});

	it("leaves every other argument alone", () => {
		expect(expandWorkspaceArgs(["--check", "bad.fish"], "/tmp/w")).toEqual([
			"--check",
			"bad.fish",
		]);
	});
});

describe("needsShell", () => {
	it("shells npm shims on Windows but never a real exe", () => {
		expect(needsShell("C:\\tools\\oxlint", "win32")).toBe(true);
		expect(needsShell("C:\\tools\\actionlint.exe", "win32")).toBe(false);
		expect(needsShell("C:\\tools\\ACTIONLINT.EXE", "win32")).toBe(false);
	});

	it("never shells off Windows", () => {
		expect(needsShell("oxlint", "linux")).toBe(false);
		expect(needsShell("oxlint", "darwin")).toBe(false);
	});
});

describe("quoteForShell", () => {
	it("leaves a plain argument alone", () => {
		expect(quoteForShell("--format")).toBe("--format");
		expect(quoteForShell("bad.toml")).toBe("bad.toml");
	});

	it("quotes whitespace and cmd metacharacters", () => {
		expect(quoteForShell("{{json .}}")).toBe('"{{json .}}"');
		expect(quoteForShell("a&b")).toBe('"a&b"');
		expect(quoteForShell("100%")).toBe('"100%"');
	});

	// #1937 round 2: the old version escaped `"` and ignored `\`. Per
	// CommandLineToArgvW a backslash run that abuts the closing quote must be
	// doubled, or the quote is escaped away and the next argument is swallowed.
	it("doubles a trailing backslash run so the closing quote survives", () => {
		expect(quoteForShell("C:\\path with space\\")).toBe(
			'"C:\\path with space\\\\"',
		);
		expect(quoteForShell("C:\\a b\\\\")).toBe('"C:\\a b\\\\\\\\"');
	});

	it("leaves an interior backslash literal", () => {
		expect(quoteForShell("C:\\a b\\c")).toBe('"C:\\a b\\c"');
	});

	it("escapes an embedded quote and the run before it", () => {
		expect(quoteForShell('say "hi"')).toBe('"say \\"hi\\""');
		expect(quoteForShell('a\\"b c')).toBe('"a\\\\\\"b c"');
	});

	it("quotes the empty string so it stays one argument", () => {
		expect(quoteForShell("")).toBe('""');
	});

	/**
	 * Round-trip against the real parser rules. Any argument this produces must
	 * decode back to itself, which is the property the character-by-character
	 * assertions above only sample.
	 */
	function parseWindowsCommandLine(commandLine: string): string[] {
		const args: string[] = [];
		let current = "";
		let inQuotes = false;
		let started = false;
		let backslashes = 0;
		const flushBackslashes = (count: number) => {
			current += "\\".repeat(count);
		};
		for (const character of commandLine) {
			if (character === "\\") {
				backslashes++;
				continue;
			}
			if (character === '"') {
				flushBackslashes(Math.floor(backslashes / 2));
				if (backslashes % 2 === 1) {
					current += '"';
				} else {
					inQuotes = !inQuotes;
					started = true;
				}
				backslashes = 0;
				continue;
			}
			flushBackslashes(backslashes);
			backslashes = 0;
			if (character === " " && !inQuotes) {
				if (started || current.length > 0) args.push(current);
				current = "";
				started = false;
				continue;
			}
			current += character;
		}
		flushBackslashes(backslashes);
		if (started || current.length > 0) args.push(current);
		return args;
	}

	it("round-trips every argument shape through the real parser rules", () => {
		const cases = [
			["--format", "{{json .}}", "bad.yml"],
			["C:\\path with space\\", "next"],
			['say "hi"', "plain"],
			['a\\"b c', "C:\\a b\\c"],
			["", "after-empty"],
			["--filter=bad.tf", "C:\\Users\\dev\\repo\\"],
		];
		for (const argv of cases) {
			const commandLine = argv.map(quoteForShell).join(" ");
			expect(parseWindowsCommandLine(commandLine), commandLine).toEqual(argv);
		}
	});
});

// #4473: the capture records the real tool's answer to the probe its runner
// sends, because the replay runs the real checker against that record. helm 4
// rejects `--version`; a record that dropped the exit status would let the
// replay read a rejected probe as installed.
describe("buildAvailability", () => {
	it("keeps the argv the checker sends and the real exit status", () => {
		expect(
			buildAvailability("helm", ["version", "--short"], "4.3.0", {
				status: 1,
				stdout: "",
				stderr: "Error: unknown flag: --short\n",
			}),
		).toEqual({
			command: "helm",
			argv: ["version", "--short"],
			version: "4.3.0",
			exitCode: 1,
			stdout: "",
			stderr: "Error: unknown flag: --short\n",
		});
	});

	it("records a spawn with no exit status as null, never as success", () => {
		const record = buildAvailability("helm", ["--version"], "4.3.0", {
			status: undefined,
			stdout: "",
			stderr: "spawn helm ENOENT",
		});
		expect(record.exitCode).toBeNull();
	});

	it("copies the argv so a later edit cannot rewrite the record", () => {
		const argv = ["--version"];
		const record = buildAvailability("yamllint", argv, "1.38.0", {
			status: 0,
		});
		argv.push("--debug");
		expect(record.argv).toEqual(["--version"]);
	});
});

// The retrofit path: fixtures captured before #4473 gain the records without
// re-recording their work bytes from a newer build (which would silently
// retarget the parser evidence).
describe("mergeRecords", () => {
	it("adds the availability and clean records and keeps the work bytes", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-merge-"));
		const dest = path.join(dir, "real.captured.json");
		const original = {
			provenance: { runner: "helm-lint", tool: "helm", version: "4.3.0" },
			file: "Chart.yaml",
			exitCode: 0,
			stdout: "captured findings",
			stderr: "",
		};
		fs.writeFileSync(dest, JSON.stringify(original));
		const merged = mergeRecords(dest, {
			availability: [
				{
					command: "helm",
					argv: ["version", "--short"],
					version: "4.3.0",
					exitCode: 0,
					stdout: "v4.3.0",
					stderr: "",
				},
			],
			clean: {
				workspace: "tests/fixtures/runner-output-clean/helm-lint",
				file: "Chart.yaml",
				argv: ["version", "--short"],
				version: "4.3.0",
				exitCode: 0,
				stdout: "",
				stderr: "",
			},
			versionArgv: ["version", "--short"],
		});
		expect(merged.stdout).toBe("captured findings");
		expect(merged.exitCode).toBe(0);
		expect(merged.availability).toHaveLength(1);
		expect((merged.provenance as Record<string, unknown>).versionArgv).toEqual([
			"version",
			"--short",
		]);
		const onDisk = JSON.parse(fs.readFileSync(dest, "utf8"));
		expect(onDisk.clean.exitCode).toBe(0);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
