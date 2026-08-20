import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
const existsSync = vi.fn();
const resolveToolCommandWithInstallFallback = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: (...args: unknown[]) => existsSync(...args),
	};
});

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	resolveToolCommandWithInstallFallback,
}));

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd);
}

describe("biome-check runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		existsSync.mockReset();
		resolveToolCommandWithInstallFallback.mockReset();
		resolveToolCommandWithInstallFallback.mockResolvedValue("biome");
		// Default: no biome config found
		existsSync.mockReturnValue(false);
	});

	it("runs diagnostics-only check without --write mutation", async () => {
		const env = setupTestEnvironment("pi-lens-biome-check-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const x = 1\n");

			// Mock that biome is available in local node_modules
			existsSync.mockImplementation((p: unknown) => {
				if (
					typeof p === "string" &&
					p.includes("node_modules") &&
					p.includes("biome")
				) {
					return true;
				}
				return false;
			});

			safeSpawnAsync
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "1.9.4",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout: JSON.stringify({ diagnostics: [] }),
					stderr: "",
				});

			const runner = (
				await import("../../../../clients/dispatch/runners/biome-check.js")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			// Log all calls for debugging
			// biomeCalls = safeSpawnAsync.mock.calls.filter((call) => call[0].includes("biome"))

			expect(
				safeSpawnAsync.mock.calls.some(
					(call) =>
						(call[1] as string[])?.includes("lint") &&
						(call[1] as string[])?.includes("--reporter=json"),
				),
			).toBe(true);
			expect(
				safeSpawnAsync.mock.calls.some((call) =>
					(call[1] as string[])?.includes("--write"),
				),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("routes a rule with a real 'Fix: safe' explain answer to fixable/autoFixAvailable (#1810)", async () => {
		const env = setupTestEnvironment("pi-lens-biome-check-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "let x = 1;\nconsole.log(x);\n");

			existsSync.mockImplementation((p: unknown) => {
				if (
					typeof p === "string" &&
					p.includes("node_modules") &&
					p.includes("biome")
				) {
					return true;
				}
				return false;
			});

			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[]) => {
					if (args[0] === "explain") {
						return {
							error: null,
							status: 0,
							stdout:
								"Summary\n\n- Name: useConst\n- Fix: safe\n- Default severity: warn\n",
							stderr: "",
						};
					}
					if (args.includes("lint")) {
						return {
							error: null,
							status: 1,
							stdout: JSON.stringify({
								diagnostics: [
									{
										severity: "warning",
										message:
											"This let declares a variable that is only assigned once.",
										category: "lint/style/useConst",
										location: {
											path: filePath,
											start: { line: 1, column: 1 },
											end: { line: 1, column: 4 },
										},
									},
								],
							}),
							stderr: "",
						};
					}
					return { error: null, status: 0, stdout: "", stderr: "" };
				},
			);

			const runner = (
				await import("../../../../clients/dispatch/runners/biome-check.js")
			).default;

			const result = await runner.run(
				createCtx(filePath, env.tmpDir) as never,
			);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].fixable).toBe(true);
			expect(result.diagnostics[0].autoFixAvailable).toBe(true);

			expect(
				safeSpawnAsync.mock.calls.some(
					(call) =>
						(call[1] as string[])?.[0] === "explain" &&
						(call[1] as string[])?.[1] === "useConst",
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("stays not-fixable when a rule genuinely has no fix ('No fix available')", async () => {
		const env = setupTestEnvironment("pi-lens-biome-check-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "if (false) { console.log(1); }\n");

			existsSync.mockImplementation((p: unknown) => {
				if (
					typeof p === "string" &&
					p.includes("node_modules") &&
					p.includes("biome")
				) {
					return true;
				}
				return false;
			});

			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[]) => {
					if (args[0] === "explain") {
						return {
							error: null,
							status: 0,
							stdout:
								"Summary\n\n- Name: noConstantCondition\n- No fix available.\n",
							stderr: "",
						};
					}
					if (args.includes("lint")) {
						return {
							error: null,
							status: 1,
							stdout: JSON.stringify({
								diagnostics: [
									{
										severity: "error",
										message:
											"This condition always evaluates to the same value.",
										category: "lint/correctness/noConstantCondition",
										location: {
											path: filePath,
											start: { line: 1, column: 5 },
											end: { line: 1, column: 10 },
										},
									},
								],
							}),
							stderr: "",
						};
					}
					return { error: null, status: 0, stdout: "", stderr: "" };
				},
			);

			const runner = (
				await import("../../../../clients/dispatch/runners/biome-check.js")
			).default;

			const result = await runner.run(
				createCtx(filePath, env.tmpDir) as never,
			);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].fixable).toBe(false);
			expect(result.diagnostics[0].autoFixAvailable).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

describe("resolveBiomeFixKinds (#1810)", () => {
	beforeEach(() => {
		safeSpawnAsync.mockReset();
	});

	it("caches a resolved rule and does not re-spawn 'explain' for it", async () => {
		const { resolveBiomeFixKinds } = await import(
			"../../../../clients/dispatch/runners/biome-check.js"
		);
		const cmd = `biome-cache-test-${Math.random()}`;

		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: "- Name: useConst\n- Fix: safe\n",
			stderr: "",
		});

		const first = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/style/useConst",
		]);
		expect(first.get("useConst")).toBe("safe");
		const callsAfterFirst = safeSpawnAsync.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThan(0);

		const second = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/style/useConst",
		]);
		expect(second.get("useConst")).toBe("safe");
		// Mutation-proofing: deleting the cache check would spawn again here.
		expect(safeSpawnAsync.mock.calls.length).toBe(callsAfterFirst);
	});

	it("never caches a transient explain-spawn failure (must retry, not poison as unfixable)", async () => {
		const { resolveBiomeFixKinds } = await import(
			"../../../../clients/dispatch/runners/biome-check.js"
		);
		const cmd = `biome-transient-test-${Math.random()}`;

		safeSpawnAsync.mockResolvedValueOnce({
			error: "spawn ENOENT",
			status: null,
			stdout: "",
			stderr: "",
		});
		const failed = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/style/useConst",
		]);
		expect(failed.get("useConst")).toBe("none");

		safeSpawnAsync.mockResolvedValueOnce({
			error: null,
			status: 0,
			stdout: "- Name: useConst\n- Fix: safe\n",
			stderr: "",
		});
		const recovered = await resolveBiomeFixKinds(cmd, "/cwd", [
			"lint/style/useConst",
		]);
		// If the transient failure had been cached, this would still read
		// "none" — the recovery here proves the cache write is gated on a
		// successful spawn.
		expect(recovered.get("useConst")).toBe("safe");
	});
});
