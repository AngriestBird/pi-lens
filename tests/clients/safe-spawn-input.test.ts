import { describe, expect, it } from "vitest";
import { safeSpawnAsync } from "../../clients/safe-spawn.js";

describe("safeSpawnAsync stdin input", () => {
	it("writes input and closes stdin", async () => {
		const result = await safeSpawnAsync(
			process.execPath,
			["-e", "process.stdin.setEncoding('utf8'); let s=''; process.stdin.on('data', x => s += x); process.stdin.on('end', () => process.stdout.write(s));"],
			{ timeout: 5000, input: "round-trip" },
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("round-trip");
	});

	it("closes stdin for an empty opt-in payload", async () => {
		const result = await safeSpawnAsync(
			process.execPath,
		["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'));"],
			{ timeout: 5000, input: "" },
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("eof");
	});
});
