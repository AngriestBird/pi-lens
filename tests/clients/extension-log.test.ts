/**
 * Behavior of the terminal-safe extension sink and the console guard (#1333).
 *
 * These load `clients/extension-log.ts` with `PI_LENS_TEST_MODE=0` and a
 * throwaway `PI_LENS_HOME`, because the sink deliberately no-ops under test
 * mode (the same contract every other pi-lens ndjson logger keeps).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome: string;
const savedEnv: Record<string, string | undefined> = {};

async function loadSink(): Promise<
	typeof import("../../clients/extension-log.js")
> {
	vi.resetModules();
	return await import("../../clients/extension-log.js");
}

function readLines(logFile: string): Record<string, unknown>[] {
	if (!fs.existsSync(logFile)) return [];
	return fs
		.readFileSync(logFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
	tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1333-"));
	for (const key of [
		"PI_LENS_TEST_MODE",
		"PI_LENS_HOME",
		"PI_LENS_CONSOLE_GUARD",
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env.PI_LENS_TEST_MODE = "0";
	process.env.PI_LENS_HOME = tempHome;
	delete process.env.PI_LENS_CONSOLE_GUARD;
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("extension-log sink (#1333)", () => {
	it("writes an ndjson line instead of touching the terminal", async () => {
		const sink = await loadSink();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			sink.logExtension({
				subsystem: "dispatch",
				message: "no config detected, using defaults",
				metadata: { filePath: "a.ts" },
			});
			await sink.flushExtensionLog();
			expect(stderr).not.toHaveBeenCalled();
			expect(stdout).not.toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
			stdout.mockRestore();
		}

		const lines = readLines(sink.getExtensionLogPath());
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			subsystem: "dispatch",
			level: "error",
			message: "no config detected, using defaults",
			metadata: { filePath: "a.ts" },
		});
		expect(typeof lines[0].ts).toBe("string");
	});

	it("createSubsystemLogger is callable and level-aware", async () => {
		const sink = await loadSink();
		const log = sink.createSubsystemLogger("ruff");
		log("verbose detail");
		log.warn("a warning");
		log.error("an error");
		await sink.flushExtensionLog();

		const lines = readLines(sink.getExtensionLogPath());
		expect(lines.map((l) => [l.subsystem, l.level, l.message])).toEqual([
			["ruff", "debug", "verbose detail"],
			["ruff", "warn", "a warning"],
			["ruff", "error", "an error"],
		]);
	});

	it("stays terminal-silent whether the verbose gate is on or off", async () => {
		const sink = await loadSink();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			// verbose OFF
			sink.noopSubsystemLogger()("hidden");
			// verbose ON — the migrated sink, not console
			sink.createSubsystemLogger("biome")("shown");
			await sink.flushExtensionLog();
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
		}
		const messages = readLines(sink.getExtensionLogPath()).map(
			(l) => l.message,
		);
		expect(messages).toEqual(["shown"]);
	});
});

describe("console guard (#1333)", () => {
	it("reroutes console.* into the sink and is idempotent", async () => {
		const sink = await loadSink();
		const original = console.error;
		expect(sink.installConsoleGuard()).toBe(true);
		expect(sink.installConsoleGuard()).toBe(false);
		try {
			expect(console.error).not.toBe(original);
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			console.error("rogue dependency line", { detail: 1 });
			console.log("rogue stdout line");
			expect(stderr).not.toHaveBeenCalled();
			stderr.mockRestore();
			await sink.flushExtensionLog();
		} finally {
			console.error = original;
		}

		const lines = readLines(sink.getExtensionLogPath()).filter(
			(l) => l.subsystem === "console",
		);
		expect(lines.map((l) => [l.level, l.message])).toEqual([
			["error", 'rogue dependency line {"detail":1}'],
			["debug", "rogue stdout line"],
		]);
	});

	it("is inert under test mode and under PI_LENS_CONSOLE_GUARD=0", async () => {
		process.env.PI_LENS_TEST_MODE = "1";
		let sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(false);

		process.env.PI_LENS_TEST_MODE = "0";
		process.env.PI_LENS_CONSOLE_GUARD = "0";
		sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(false);
	});
});
