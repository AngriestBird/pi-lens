import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { waitForChildExit, withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — child death is only observable at the real process boundary
describe("real pi harness: child lifecycle", () => {
	it("waits for a real child to report exit before teardown continues", async () => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		const started = Date.now();
		await waitForChildExit(child);
		expect(Date.now() - started).toBeGreaterThanOrEqual(75);
		expect(child.exitCode).toBe(0);
	});

	// PATH is emptied so the child can start only through the harness's own
	// PATH head (#3742); a bare `pi` lookup would exit before the kill.
	it("rejects a governed wait immediately when pi is killed", async () => {
		await withRealPi(
			{ fixture: "scenario-1", script: "script.json", env: { PATH: "" } },
			async (pi) => {
				await pi.prompt("start a turn");
				const started = Date.now();
				const pending = pi.awaitToolResult("never-produced");
				pi.killChildForTest();
				await expect(pending).rejects.toMatchObject({
					name: "RealPiChildExitError",
					signal: "SIGKILL",
				});
				expect(Date.now() - started).toBeLessThan(2_000);
			},
		);
	}, 60_000);
});
