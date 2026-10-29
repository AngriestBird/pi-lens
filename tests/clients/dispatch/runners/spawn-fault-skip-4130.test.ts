/**
 * RECURRENCE THIS PREVENTS: #4130 item 3. pyright and prisma-validate turned a
 * tool that resolved and then failed to spawn into a bare skip, which
 * `scripts/smoke-tools.mjs` rendered as "tool absent (not a failure)". The skip
 * names the fault when the tool was invoked and stays bare when it was not.
 * The process boundary (`safeSpawnAsync`) is the only double.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, resolvedCommand } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	resolvedCommand: { current: "tool" as string | null },
}));

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
	findCommandAsync: async () => null,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: () => ({
			isAvailable: () => resolvedCommand.current !== null,
			isAvailableAsync: async () => resolvedCommand.current !== null,
			getCommand: () => resolvedCommand.current,
		}),
		resolveAvailableOrInstall: async () => resolvedCommand.current,
		resolveLocalFirstAsync: async () => ({ cmd: "prisma", args: [] }),
	}),
);

const SPAWN_TIMEOUT = {
	error: new Error("Process timed out after 60000ms"),
	status: null,
	stdout: "",
	stderr: "",
};

describe("a runner whose resolved tool failed to spawn names the fault (#4130)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		resolvedCommand.current = "tool";
	});

	it.each([
		["pyright", "python", "app.py", "x = 1\n"],
		["prisma-validate", "prisma", "schema.prisma", "model A { id Int @id }\n"],
	] as const)(
		"%s",
		async (id, kind, file, source) => {
			const env = setupTestEnvironment(`pi-lens-${id}-spawn-fault-`);
			try {
				const filePath = path.join(env.tmpDir, file);
				fs.writeFileSync(filePath, source);
				const ctx = makeRunnerCtx(filePath, env.tmpDir, {
					kind,
					pi: { getFlag: (name: string) => name === "no-lsp" },
				} as never);
				const runner = (
					await import(`../../../../clients/dispatch/runners/${id}.js`)
				).default;

				safeSpawnAsync.mockResolvedValue(SPAWN_TIMEOUT);
				const broke = await runner.run(ctx as never);
				expect(broke.status).toBe("skipped");
				expect(broke.skipFault).toBe("did-not-run");
				expect(safeSpawnAsync).toHaveBeenCalled();

				// Nothing to invoke: pyright skips bare (prisma has no availability
				// gate; its resolver always yields a command, so only pyright has this arm).
				if (id === "pyright") {
					safeSpawnAsync.mockClear();
					resolvedCommand.current = null;
					const absent = await runner.run(ctx as never);
					expect(absent.status).toBe("skipped");
					expect(absent.skipFault).toBeUndefined();
					expect(safeSpawnAsync).not.toHaveBeenCalled();
				}
			} finally {
				env.cleanup();
			}
		},
		30_000,
	);
});
