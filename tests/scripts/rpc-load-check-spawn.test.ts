// flake-shape: real-process-spawn — the subject is the script's own process
// contract: it spawns a `pi` child, reads its JSONL, and its exit code is what
// install-smoke reads. The child is a stand-in at the true process boundary
// (tests/fixtures/rpc-load-check/fake-pi.mjs); an in-process call of the
// classifier cannot prove that a pi that exits, or a signal that arrives on the
// wire, turns the exit code red.
// lane: wall-clock-budget (serialized); no wall-clock assertion, each case is
// a ~2 s run of the script.
/**
 * #4401, recurrences #4400 (pi exited at session start and the old check had
 * no way to see an exit) and #4314 (a failed warm is a log line, not an
 * `extension_error`). Each case injects exactly one signal into the stand-in
 * pi and expects the script's exit code and message.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = path.resolve("scripts/rpc-load-check.mjs");
const FAKE_PI = path.resolve("tests/fixtures/rpc-load-check/fake-pi.mjs");

async function smoke(mode: string, extraArgs: string[] = []) {
	const env: NodeJS.ProcessEnv = { ...process.env, FAKE_PI_MODE: mode };
	// The ambient VITEST variables belong to the outer worker.
	for (const key of Object.keys(env))
		if (key.startsWith("VITEST") || key === "TEST") delete env[key];
	try {
		const { stdout } = await run(
			process.execPath,
			[SCRIPT, FAKE_PI, "--extension", "/unused", ...extraArgs],
			{ env, timeout: 60_000 },
		);
		return { code: 0, out: stdout };
	} catch (err) {
		const failure = err as { code: number; stdout: string };
		return { code: failure.code, out: failure.stdout };
	}
}

describe.skipIf(process.platform === "win32")(
	// The fixture is a shebang script; the Windows lane has no way to exec it.
	"scripts/rpc-load-check.mjs exit code (#4401)",
	() => {
		it("passes a pi that loads, warms up and finishes the first turn", async () => {
			const result = await smoke("clean");
			expect(result.out).toContain("PASS");
			expect(result.code).toBe(0);
		});

		it("fails a pi that exits during start-up (#4400)", async () => {
			const result = await smoke("host-exit");
			expect(result.out).toContain("FAIL: pi exited during");
			expect(result.code).toBe(1);
		});

		it("fails an extension_error event", async () => {
			const result = await smoke("extension-error");
			expect(result.out).toContain("FAIL: extension_error: boom");
			expect(result.code).toBe(1);
		});

		it("fails a warning notice", async () => {
			const result = await smoke("warning-notice");
			expect(result.out).toContain("FAIL: warning notice: something degraded");
			expect(result.code).toBe(1);
		});

		it("fails a pi-lens warn line in extension.log (#4314)", async () => {
			const result = await smoke("log-warn");
			expect(result.out).toContain(
				"FAIL: extension.log warn [lsp]: LSP warm failed",
			);
			expect(result.code).toBe(1);
		});

		it("fails a pi that registers no lens-* commands", async () => {
			const result = await smoke("no-commands");
			expect(result.out).toContain("FAIL: pi-lens registered no commands");
			expect(result.code).toBe(1);
		});

		it("failing-worker variant: passes when pi survives and logs the forced fallback", async () => {
			const result = await smoke("clean", ["--fail-worker"]);
			expect(result.out).toContain("with the snapshot worker forced to fail");
			expect(result.code).toBe(0);
		});

		it("failing-worker variant: still fails a pi that exits", async () => {
			const result = await smoke("host-exit", ["--fail-worker"]);
			expect(result.out).toContain("FAIL: pi exited during");
			expect(result.code).toBe(1);
		});
	},
);
