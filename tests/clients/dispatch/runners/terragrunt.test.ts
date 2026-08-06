import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn();
const getLinterPolicyForCwd = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
}));

vi.mock("../../../../clients/tool-policy.js", () => ({
	getLinterPolicyForCwd,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: (command: string) => ({
		isAvailableAsync: async () => true,
		getCommand: () => command,
	}),
}));

function createCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "terragrunt" as const,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("terragrunt runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		ensureTool.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue({
			runnerNames: ["terragrunt"],
			preferredRunners: ["terragrunt"],
			defaultRunner: "terragrunt",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		});
	});

	it("runs terragrunt hcl validate from the edited file directory", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const nestedDir = path.join(env.tmpDir, "infra", "stack");
			fs.mkdirSync(nestedDir, { recursive: true });
			const filePath = path.join(nestedDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, 'include "root" {\n  path = find_in_parent_folders()\n}\n');

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify({ invalid_files: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"terragrunt",
				expect.arrayContaining([
					"hcl",
					"validate",
					"--json",
					"--non-interactive",
					"--filter=terragrunt.hcl",
				]),
				expect.objectContaining({ cwd: nestedDir }),
			);
		} finally {
			env.cleanup();
		}
	});

	it("parses the nested invalid_files shape with numeric severity", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					invalid_files: [
						{
							diagnostics: [
								{
									severity: 1,
									summary: "bad block",
									range: {
										filename: "terragrunt.hcl",
										start: { line: 3, column: 2 },
									},
								},
							],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toMatchObject({
				line: 3,
				column: 2,
				severity: "error",
				semantic: "blocking",
				tool: "terragrunt",
			});
		} finally {
			env.cleanup();
		}
	});

	it("parses a flat diagnostic array with string severity", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "root.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify([
					{
						severity: "warning",
						summary: "unused local",
						range: {
							filename: "root.hcl",
							start: { line: 5, column: 1 },
						},
					},
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toMatchObject({
				line: 5,
				severity: "warning",
				semantic: "warning",
			});
		} finally {
			env.cleanup();
		}
	});

	it("drops diagnostics reported against other files in the unit", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					invalid_files: [
						{
							diagnostics: [
								{
									severity: 1,
									summary: "problem elsewhere",
									range: {
										filename: "other.hcl",
										start: { line: 2, column: 1 },
									},
								},
								{
									severity: 1,
									summary: "problem here",
									range: {
										filename: "terragrunt.hcl",
										start: { line: 4, column: 1 },
									},
								},
							],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].message).toBe("problem here");
		} finally {
			env.cleanup();
		}
	});

	it("returns no diagnostics for malformed JSON", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "not json at all",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(result.diagnostics).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("proceeds when no linter policy applies", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			getLinterPolicyForCwd.mockReturnValue(null);
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify({ invalid_files: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(safeSpawnAsync).toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("still parses stdout when the spawn reports an error", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: new Error("exit status 1"),
				status: 1,
				stdout: JSON.stringify([
					{
						severity: 1,
						summary: "bad attribute",
						range: {
							filename: "terragrunt.hcl",
							start: { line: 2, column: 3 },
						},
					},
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("failed");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].message).toBe("bad attribute");
		} finally {
			env.cleanup();
		}
	});

	it("rolls mixed error and warning diagnostics up to failed/blocking", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: JSON.stringify([
					{
						severity: 2,
						summary: "unused local",
						range: { filename: "terragrunt.hcl", start: { line: 1, column: 1 } },
					},
					{
						severity: 1,
						summary: "invalid block",
						range: { filename: "terragrunt.hcl", start: { line: 4, column: 1 } },
					},
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics).toHaveLength(2);
			expect(result.diagnostics.map((d: { severity: string }) => d.severity)).toEqual([
				"warning",
				"error",
			]);
		} finally {
			env.cleanup();
		}
	});

	// vi.doMock of runner-helpers leaks past resetModules, so the availability-off
	// tests (this one and the managed-fallback one) run after every test that
	// needs the real availability checker.
	it("skips when the tool is unavailable", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			vi.doMock(
				"../../../../clients/dispatch/runners/utils/runner-helpers.js",
				() => ({
					createAvailabilityChecker: () => ({
						isAvailableAsync: async () => false,
						getCommand: () => null,
					}),
				}),
			);
			ensureTool.mockResolvedValue(null);

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("falls back to the managed binary when terragrunt is not on PATH", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			vi.doMock(
				"../../../../clients/dispatch/runners/utils/runner-helpers.js",
				() => ({
					createAvailabilityChecker: () => ({
						isAvailableAsync: async () => false,
						getCommand: () => null,
					}),
				}),
			);
			ensureTool.mockResolvedValue("/managed/bin/terragrunt");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify({ invalid_files: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(ensureTool).toHaveBeenCalledWith("terragrunt");
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"/managed/bin/terragrunt",
				expect.arrayContaining(["hcl", "validate"]),
				expect.anything(),
			);
		} finally {
			env.cleanup();
		}
	});

	it("skips when policy prefers a different runner", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			getLinterPolicyForCwd.mockReturnValue({
				runnerNames: ["terragrunt"],
				preferredRunners: [],
				defaultWhenUnconfigured: false,
				gate: "config-first",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});

describe("parseTerragruntOutput", () => {
	async function parse(raw: string, filePath = "/repo/terragrunt.hcl") {
		const { parseTerragruntOutput } = await import(
			"../../../../clients/dispatch/runners/terragrunt.js"
		);
		return parseTerragruntOutput(raw, filePath);
	}

	it("returns [] for empty or whitespace-only output", async () => {
		expect(await parse("")).toEqual([]);
		expect(await parse("  \n\t")).toEqual([]);
	});

	it("returns [] when invalid_files is present but not an array", async () => {
		expect(await parse(JSON.stringify({ invalid_files: {} }))).toEqual([]);
		expect(await parse(JSON.stringify({ invalid_files: "oops" }))).toEqual([]);
	});

	it("returns [] for JSON scalar payloads", async () => {
		expect(await parse("null")).toEqual([]);
		expect(await parse("42")).toEqual([]);
		expect(await parse('"error"')).toEqual([]);
	});

	it("skips null and non-object entries in a flat array, keeping valid ones", async () => {
		const diagnostics = await parse(
			JSON.stringify([null, "junk", 7, { severity: 1, summary: "real" }]),
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe("real");
	});

	it("ignores invalid_files entries whose diagnostics is missing or not an array", async () => {
		const diagnostics = await parse(
			JSON.stringify({
				invalid_files: [
					null,
					{},
					{ diagnostics: "nope" },
					{ diagnostics: [{ severity: 1, summary: "kept" }] },
				],
			}),
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe("kept");
	});

	it("defaults to line 1 column 1 when range is missing", async () => {
		const diagnostics = await parse(
			JSON.stringify([{ severity: 1, summary: "no range" }]),
		);
		expect(diagnostics[0]).toMatchObject({ line: 1, column: 1 });
	});

	it("keeps diagnostics that carry no range.filename", async () => {
		const diagnostics = await parse(
			JSON.stringify([
				{ severity: 1, summary: "unit-level", range: { start: { line: 2, column: 5 } } },
			]),
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ line: 2, column: 5 });
	});

	it("falls back to a generic message when summary and detail are both missing", async () => {
		const diagnostics = await parse(JSON.stringify([{ severity: 1 }]));
		expect(diagnostics[0].message).toBe("terragrunt hcl validate error");
	});

	it("uses detail as the message when summary is missing", async () => {
		const diagnostics = await parse(
			JSON.stringify([{ severity: 1, detail: "the long explanation" }]),
		);
		expect(diagnostics[0].message).toBe("the long explanation");
	});

	it("maps numeric severity 2 to a non-blocking warning", async () => {
		const diagnostics = await parse(JSON.stringify([{ severity: 2, summary: "w" }]));
		expect(diagnostics[0]).toMatchObject({ severity: "warning", semantic: "warning" });
	});

	it("matches string severity case-insensitively", async () => {
		const diagnostics = await parse(
			JSON.stringify([{ severity: "ERROR", summary: "e" }]),
		);
		expect(diagnostics[0]).toMatchObject({ severity: "error", semantic: "blocking" });
	});

	it("treats unknown string severities as warning", async () => {
		const diagnostics = await parse(
			JSON.stringify([{ severity: "info", summary: "i" }]),
		);
		expect(diagnostics[0]).toMatchObject({ severity: "warning", semantic: "warning" });
	});
});
