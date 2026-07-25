/**
 * Regression: #214 — the Windows cmd.exe spawn string escaped only the args,
 * not the command, so a tool whose path contains a space (e.g. Go installed at
 * `C:\Program Files\Go\bin\go.exe`) made cmd.exe parse `C:\Program` as the
 * command and fail with "'C:\Program' is not recognized". This silently broke
 * any tool under a spaced path on Windows (go-vet exposed it). The command is
 * now escaped like the args.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildWindowsShellCommand,
	resetSafeSpawnWindowsCommandCache,
	safeSpawnAsync,
} from "../../clients/safe-spawn.js";

describe("buildWindowsShellCommand (Windows cmd.exe quoting — #214)", () => {
	it("quotes a command path containing spaces", () => {
		const s = buildWindowsShellCommand("C:\\Program Files\\Go\\bin\\go.exe", [
			"vet",
			"x.go",
		]);
		expect(s).toContain('"C:\\Program Files\\Go\\bin\\go.exe"');
		// the command must be quoted as a single token, not split on the space
		expect(s).not.toMatch(/&& C:\\Program Files/);
	});

	it("leaves a space-free command unquoted (no regression for npm/.pi-lens paths)", () => {
		expect(buildWindowsShellCommand("ruff", ["check", "x.py"])).toBe(
			"chcp 65001 >nul 2>&1 && ruff check x.py",
		);
	});

	it("escapes args containing spaces too", () => {
		const s = buildWindowsShellCommand("tool", ["--path", "C:\\a b\\c.txt"]);
		expect(s).toContain('"C:\\a b\\c.txt"');
	});

	it("always prefixes the UTF-8 code-page switch", () => {
		expect(buildWindowsShellCommand("go", ["version"])).toMatch(
			/^chcp 65001 >nul 2>&1 && /,
		);
	});

	it("keeps shell metacharacters inside one argument", () => {
		const command = buildWindowsShellCommand("tool", ["safe & echo INJECTED"]);
		expect(command).toContain('"safe & echo INJECTED"');
	});
});

describe("safeSpawnAsync command-line injection regression (#17)", () => {
	it("does not execute shell syntax supplied as an argument", async () => {
		const result = await safeSpawnAsync("echo", ["safe & echo INJECTED"]);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("safe & echo INJECTED");
		expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
	});
});

// ============================================================================
// #817 — direct .exe spawns + validated .cmd/.bat wrapper.
// Windows-only: these exercise real process resolution/spawning behavior that
// only exists on win32 (resolveWindowsCommand's PATH+PATHEXT walk, the pinned
// cmd.exe wrapper). This machine (Windows 11) runs them for real.
// ============================================================================
describe.runIf(process.platform === "win32")(
	"Windows command resolution + direct spawn (#817)",
	() => {
		let fixtureDir: string;
		let echoArgsScript: string;
		let echoArgsCmd: string;

		beforeAll(() => {
			fixtureDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-safe-spawn-817-"),
			);
			echoArgsScript = path.join(fixtureDir, "echo-args.js");
			fs.writeFileSync(
				echoArgsScript,
				"process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
				"utf-8",
			);
			echoArgsCmd = path.join(fixtureDir, "echo-args.cmd");
			// Forwards every argument the .cmd shim receives, verbatim, to the
			// node fixture script via %* — used to assert args-with-spaces
			// round-trip through the cmd.exe wrapper unmangled.
			fs.writeFileSync(
				echoArgsCmd,
				`@echo off\r\n"${process.execPath}" "${echoArgsScript}" %*\r\n`,
				"utf-8",
			);
		});

		afterAll(() => {
			fs.rmSync(fixtureDir, { recursive: true, force: true });
		});

		it("(a) resolves a bare command via PATH+PATHEXT and spawns the .exe directly, no cmd.exe involved", async () => {
			// node.exe itself is guaranteed present (it's what runs the test
			// runner) and is a plain .exe — the common case (sg/biome/ruff/git).
			const result = await safeSpawnAsync(path.basename(process.execPath), [
				"-e",
				"console.log('direct-exe-ok')",
			]);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("direct-exe-ok");
		});

		it("(b) a .cmd shim still executes through the pinned cmd.exe wrapper, args with spaces round-trip", async () => {
			const result = await safeSpawnAsync(echoArgsCmd, [
				"hello world",
				"plain",
			]);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual(["hello world", "plain"]);
		});

		it('(c) an arg containing "%" targeting a .cmd shim is rejected loudly, nothing spawned', async () => {
			const result = await safeSpawnAsync(echoArgsCmd, ["%APPDATA%.md"]);
			expect(result.error).toBeDefined();
			expect(result.error?.message).toMatch(/cmd\.exe/i);
			expect(result.status).toBeNull();
			expect(result.stdout).toBe("");
		});

		it('(c) an arg containing a literal quote targeting a .cmd shim is rejected loudly, nothing spawned', async () => {
			const result = await safeSpawnAsync(echoArgsCmd, ['embedded"quote']);
			expect(result.error).toBeDefined();
			expect(result.error?.message).toContain(
				JSON.stringify('embedded"quote'),
			);
			expect(result.status).toBeNull();
			expect(result.stdout).toBe("");
		});

		it("(d) the same %/quote args pass through literally to a direct .exe spawn (array args are safe)", async () => {
			const dangerous = 'weird"quote%percent!bang';
			const result = await safeSpawnAsync(process.execPath, [
				echoArgsScript,
				dangerous,
			]);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual([dangerous]);
		});

		it("(e) an unresolvable command returns an ENOENT-shaped error (today's tool-not-installed detection)", async () => {
			const result = await safeSpawnAsync(
				"pi-lens-definitely-not-a-real-command-817",
				["--version"],
			);
			expect(result.status).toBeNull();
			expect(result.error).toBeDefined();
			expect(result.error?.message).toContain("ENOENT");
			expect((result.error as NodeJS.ErrnoException).code).toBe("ENOENT");
		});

		it("(f) resolver cache: second resolve of the same command is a cache hit, reset hook clears it", async () => {
			// Not directly observable from outside, but exercising the same
			// command twice must keep working (a stale-cache bug would break the
			// second call, not the first), and the reset hook must not throw and
			// must not break subsequent resolution either.
			const first = await safeSpawnAsync(path.basename(process.execPath), [
				"-e",
				"console.log('cache-1')",
			]);
			const second = await safeSpawnAsync(path.basename(process.execPath), [
				"-e",
				"console.log('cache-2')",
			]);
			expect(first.stdout).toContain("cache-1");
			expect(second.stdout).toContain("cache-2");

			resetSafeSpawnWindowsCommandCache();

			const third = await safeSpawnAsync(path.basename(process.execPath), [
				"-e",
				"console.log('cache-3')",
			]);
			expect(third.error).toBeUndefined();
			expect(third.stdout).toContain("cache-3");
		});
	},
);
