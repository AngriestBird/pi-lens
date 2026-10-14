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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = path.resolve("scripts/rpc-load-check.mjs");
// A failing run keeps its scratch dir for forensics; keep it out of the shared tmp.
const tmpRoot = fs.mkdtempSync(
	path.join(os.tmpdir(), "pi-lens-rpc-load-check-"),
);
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const FAKE_PI = path.resolve("tests/fixtures/rpc-load-check/fake-pi.mjs");

async function smoke(
	mode: string,
	extraArgs: string[] = [],
	stageMs?: number,
	marker?: string,
) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		FAKE_PI_MODE: mode,
		TMPDIR: tmpRoot,
	};
	if (stageMs) env.RPC_LOAD_CHECK_STAGE_TIMEOUT_MS = String(stageMs);
	if (marker) env.FAKE_PI_MARKER = marker;
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
		it("fails a first turn that ends in an error, not a stop", async () => {
			const result = await smoke("turn-error");
			expect(result.out).toContain("first turn did not finish cleanly");
			expect(result.code).toBe(1);
		});

		it("fails a first turn that never reached the provider", async () => {
			const result = await smoke("no-provider");
			expect(result.out).toContain("never reached the fake provider");
			expect(result.code).toBe(1);
		});

		it("times out (exit 2) when the warm-up never completes", async () => {
			const result = await smoke("no-warmup", [], 2000);
			expect(result.out).toContain("TIMEOUT waiting for session-start warm-up");
			expect(result.code).toBe(2);
		});

		it("times out (exit 2) when the first turn never ends", async () => {
			const result = await smoke("no-agent-end", [], 2000);
			expect(result.out).toContain("TIMEOUT waiting for first turn");
			expect(result.code).toBe(2);
		});

		it("failing-worker variant: times out when the forced fallback is never logged", async () => {
			// Without this the variant would be a vacuous green: pi surviving proves
			// nothing if the seam never made the worker fail.
			const result = await smoke("no-fallback", ["--fail-worker"], 2000);
			expect(result.out).toContain(
				"TIMEOUT waiting for the forced worker failure",
			);
			expect(result.code).toBe(2);
		});
		// Recurrence: #4441 review F2. The bare-tsc refusal (#4414) logs about a
		// second after the turn ends. A check that reads the logs a fixed second
		// after agent_end passed published 4.4.3 whenever the tsc probe took 2 s
		// or more. The fake logs the refusal 2.5 s after agent_end.
		it("fails a TypeScript server refusal that logs seconds after the turn ends", async () => {
			const result = await smoke("ts-late-refusal", [], 20_000);
			expect(result.out).toContain(
				"the TypeScript language server did not start",
			);
			expect(result.out).toContain("project-local LSP binary refused");
			expect(result.code).toBe(1);
		});

		it("waits for a TypeScript server that starts seconds after the turn ends", async () => {
			const result = await smoke("ts-late-start", [], 20_000);
			expect(result.out).toContain("PASS");
			expect(result.code).toBe(0);
		});

		it("times out (exit 2) when the TypeScript server neither starts nor fails", async () => {
			// A smoke that never saw the server start proves nothing about the LSP leg.
			const result = await smoke("ts-never", [], 2000);
			expect(result.out).toContain(
				"TIMEOUT waiting for the TypeScript language server to start or fail",
			);
			expect(result.code).toBe(2);
		});

		it("fails, naming it, when the smoke project is not trusted (the LSP leg would be dark)", async () => {
			// Recurrence: #4409 round 1. An untrusted CI project refused the LSP
			// spawn; the allow-listed refusal then hid that the leg never ran.
			const result = await smoke("untrusted");
			expect(result.out).toContain("FAIL: smoke project is not trusted");
			expect(result.code).toBe(1);
		});

		it("prints the offending record in full and the log tails on failure", async () => {
			const result = await smoke("log-warn");
			expect(result.out).toContain(
				'offending record (extension.log): {"level":"warn"',
			);
			expect(result.out).toContain("--- sessionstart.log (last 40 lines)");
			expect(result.out).toContain("--- extension.log (last 40 lines)");
			expect(result.out).toContain("project trust = trusted");
		});

		it("retries once when the language-server install failed, and passes on the second run", async () => {
			const marker = path.join(tmpRoot, "install-once-marker");
			fs.rmSync(marker, { force: true });
			const result = await smoke("install-fail-once", [], undefined, marker);
			expect(result.out).toContain("install failure: ");
			expect(result.out).toContain("retrying once");
			expect(result.out).toContain("PASS");
			expect(result.code).toBe(0);
		});

		it("fails after the one retry when the install keeps failing, printing the install lines", async () => {
			const result = await smoke("install-fail-always");
			expect(result.out.match(/retrying once/g)).toHaveLength(1);
			expect(result.out.match(/install failure: /g)).toHaveLength(2);
			expect(result.code).toBe(1);
		});
	},
);
