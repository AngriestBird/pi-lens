import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifySpawnFailure,
	safeSpawnAsync,
} from "../../clients/safe-spawn.js";
import { removeTempDirSync } from "./test-utils.js";

describe("safe-spawn typed failure taxonomy", () => {
	it("distinguishes an unresolvable cwd from a missing present tool", async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-spawn-cwd-"));
		const missingCwd = path.join(parent, "gone");
		try {
			const result = await safeSpawnAsync(process.execPath, ["--version"], {
				cwd: missingCwd,
				timeout: 5_000,
			});

			expect(result.failure).toBe("spawn");
			expect(result.spawnFailure?.kind).toBe("cwd-unresolvable");
			expect(
				(result.spawnFailure?.cause as NodeJS.ErrnoException | undefined)?.code,
			).toBe("ENOENT");
		} finally {
			removeTempDirSync(parent);
		}
	});

	it("classifies errno intent while preserving the original Error as cause", async () => {
		const missing = Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" });
		const denied = Object.assign(new Error("spawn denied EACCES"), { code: "EACCES" });
		const other = Object.assign(new Error("spawn busy EBUSY"), { code: "EBUSY" });

		const missingFailure = await classifySpawnFailure(missing, { command: "missing" });
		const deniedFailure = await classifySpawnFailure(denied, { command: "denied" });
		const otherFailure = await classifySpawnFailure(other, { command: "busy" });

		expect(missingFailure.kind).toBe("tool-not-found");
		expect(missingFailure.cause).toBe(missing);
		expect(deniedFailure.kind).toBe("permission-denied");
		expect(deniedFailure.cause).toBe(denied);
		expect(otherFailure.kind).toBe("spawn-failed");
		expect((otherFailure.cause as NodeJS.ErrnoException).code).toBe("EBUSY");
	});

	it("exposes timeout and killed as typed process-control failures", async () => {
		const timeout = await safeSpawnAsync(process.execPath, ["--version"], {
			timeout: 0,
		});
		const controller = new AbortController();
		controller.abort();
		const killed = await safeSpawnAsync(process.execPath, ["--version"], {
			signal: controller.signal,
		});

		expect(timeout.spawnFailure?.kind).toBe("timeout");
		expect(timeout.spawnFailure?.cause).toBe(timeout.error);
		expect(killed.spawnFailure?.kind).toBe("killed");
		expect(killed.spawnFailure?.cause).toBe(killed.error);
	});
});
