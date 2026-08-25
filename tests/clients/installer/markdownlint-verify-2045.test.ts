import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
const sessionLog = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));
vi.mock("../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: sessionLog,
}));

import { TOOLS, verifyToolBinary } from "../../../clients/installer/index.js";
import { removeTempDirSync } from "../test-utils.js";

const fixture = fs.readFileSync(
	path.join(
		process.cwd(),
		"tests",
		"fixtures",
		"installer",
		"markdownlint-cli2-verify.stdout.txt",
	),
	"utf8",
);

function result(overrides: Record<string, unknown> = {}) {
	return {
		stdout: "",
		stderr: "",
		status: 1,
		...overrides,
	};
}

describe("managed markdownlint verification (#2045)", () => {
	it("uses the captured bounded stdin command", () => {
		const tool = TOOLS.find((entry) => entry.id === "markdownlint");
		expect(tool?.checkArgs).toEqual(["--no-globs", "-"]);
		expect(fixture).toContain("markdownlint-cli2 v0.23.2");
		expect(fixture).toContain("Linting: 1 file");
		expect(fixture).toContain("Summary: 0 issues in 0 files");
	});

	it.each([
		"tool-not-found",
		"cwd-unresolvable",
		"permission-denied",
		"timeout",
		"killed",
		"spawn-failed",
	] as const)(
		"keeps typed spawn failure %s over generic error",
		async (kind) => {
			sessionLog.mockClear();
			safeSpawnAsync.mockResolvedValueOnce(
				result({ error: new Error("generic race"), spawnFailure: { kind } }),
			);
			await expect(
				verifyToolBinary("typed-failure", undefined, undefined, 10),
			).resolves.toBe(false);
			expect(sessionLog).toHaveBeenLastCalledWith(
				expect.stringContaining(`kind=${kind}`),
			);
		},
	);

	it("covers signal-only, nonzero, and successful output", async () => {
		sessionLog.mockClear();
		safeSpawnAsync.mockResolvedValueOnce(
			result({ signal: "SIGTERM", error: new Error("killed") }),
		);
		await expect(
			verifyToolBinary("signal-only", undefined, undefined, 10),
		).resolves.toBe(false);
		expect(sessionLog).toHaveBeenLastCalledWith(
			expect.stringContaining("kind=killed-signal=SIGTERM"),
		);
		safeSpawnAsync.mockResolvedValueOnce(result({ status: 3 }));
		await expect(
			verifyToolBinary("nonzero", undefined, undefined, 10),
		).resolves.toBe(false);
		expect(sessionLog).toHaveBeenLastCalledWith(
			expect.stringContaining("kind=exit-nonzero"),
		);
		const onVersion = vi.fn();
		safeSpawnAsync.mockResolvedValueOnce(
			result({ status: 0, stdout: "real output\n", error: undefined }),
		);
		await expect(
			verifyToolBinary("success", onVersion, undefined, 10),
		).resolves.toBe(true);
		expect(onVersion).toHaveBeenCalledWith("real output\n");
		expect(sessionLog).toHaveBeenLastCalledWith(
			expect.stringContaining("command=--version"),
		);
	});

	it("passes a command override to the real spawn seam", async () => {
		safeSpawnAsync.mockResolvedValueOnce(
			result({ status: 0, error: undefined }),
		);
		await verifyToolBinary("markdownlint-cli2", undefined, undefined, 10, [
			"--no-globs",
			"-",
		]);
		expect(safeSpawnAsync).toHaveBeenLastCalledWith(
			process.platform === "win32"
				? "markdownlint-cli2.cmd"
				: "markdownlint-cli2",
			["--no-globs", "-"],
			expect.objectContaining({ timeout: 10 }),
		);
	});

	it("proves the old real probe names --version while the corrected probe is bounded", async () => {
		const binary = process.env.PI_LENS_2045_MARKDOWNLINT_BIN;
		if (!binary) return;
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-2045-markdownlint-"),
		);
		try {
			fs.writeFileSync(path.join(cwd, "project.md"), "# title\n", "utf8");
			const runProbe = async (args: string[]) => {
				const command =
					process.platform === "win32"
						? (process.env.ComSpec ?? "cmd.exe")
						: binary;
				const commandArgs =
					process.platform === "win32" ? ["/d", "/c", binary, ...args] : args;
				return await new Promise<{ stdout: string; stderr: string }>(
					(resolve) => {
						const child = execFile(
							command,
							commandArgs,
							{ cwd, timeout: 10000 },
							(_error, stdout, stderr) => {
								resolve({ stdout: String(stdout), stderr: String(stderr) });
							},
						);
						child.stdin?.end();
					},
				);
			};
			const oldProbe = await runProbe(["--version"]);
			expect(`${oldProbe.stdout}\n${oldProbe.stderr}`).toContain(
				"Finding: --version",
			);
			const corrected = await runProbe(["--no-globs", "-"]);
			expect(corrected.stdout).not.toContain("Finding: --version");
		} finally {
			removeTempDirSync(cwd);
		}
	}, 15_000);
});
