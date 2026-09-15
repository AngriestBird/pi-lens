/**
 * #3038: the real FormatService path must not amplify inferred indentation.
 * The process boundary is the only mocked seam; formatter loading, selection,
 * command resolution, and formatFile remain in-process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FormatService } from "../../clients/format-service.js";
import { clearFormatterRuntimeState } from "../../clients/formatters.js";
import { setupTestEnvironment } from "./test-utils.js";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	getAmbientAbortSignal: () => undefined,
	isCommandAvailableAsync: async () => false,
}));

function writeBiomeEvidence(root: string): void {
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.0.0" } }),
	);
	fs.writeFileSync(
		path.join(root, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: { "node_modules/@biomejs/biome": { version: "2.0.0" } },
		}),
	);
	const bin = path.join(
		root,
		"node_modules",
		".bin",
		process.platform === "win32" ? "biome.cmd" : "biome",
	);
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	fs.writeFileSync(bin, "mock biome\n");
	if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
}

const fixture = [
	"function values() {",
	"  return [",
	"      1,",
	"      2,",
	"      3,",
	"      4,",
	"      5,",
	"      6,",
	"      7,",
	"      8,",
	"      9,",
	"      10,",
	"  ];",
	"}",
	"",
].join("\n");

describe("formatter indentation inference through FormatService (#3038)", () => {
	beforeEach(() => {
		safeSpawnAsync.mockReset();
		clearFormatterRuntimeState();
	});

	it("keeps a no-config TypeScript fixture byte-identical on the second run", async () => {
		const env = setupTestEnvironment("pi-lens-format-indent-");
		try {
			writeBiomeEvidence(env.tmpDir);
			const filePath = path.join(env.tmpDir, "values.ts");
			fs.writeFileSync(filePath, fixture);
			const argv: string[][] = [];
			safeSpawnAsync.mockImplementation(async (_command: string, args: string[]) => {
				argv.push(args);
				const width = Number(args[args.indexOf("--indent-width") + 1]);
				const current = fs.readFileSync(filePath, "utf8");
				fs.writeFileSync(
					filePath,
					current.replace(/^( +)(?=\S)/gm, (spaces) =>
						" ".repeat((spaces.length / 2) * width),
					),
				);
				return { status: 0, stdout: "", stderr: "" };
			});

			const service = new FormatService("format-indent", true);
			service.recordRead(filePath);
			await service.formatFile(filePath);
			const afterFirst = fs.readFileSync(filePath, "utf8");
			await service.formatFile(filePath);

			expect(argv).toHaveLength(2);
			expect(argv[0]).toEqual(argv[1]);
			expect(fs.readFileSync(filePath, "utf8")).toBe(afterFirst);
		} finally {
			env.cleanup();
		}
	});

	it("pins the structural unit for aligned continuation indentation", async () => {
		const env = setupTestEnvironment("pi-lens-format-indent-continuation-");
		try {
			writeBiomeEvidence(env.tmpDir);
			const filePath = path.join(env.tmpDir, "continuation.ts");
			fs.writeFileSync(
				filePath,
				"const value = call(\n      first,\n      second,\n    );\n",
			);
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const service = new FormatService("format-indent-continuation", true);
			service.recordRead(filePath);
			await service.formatFile(filePath);

			expect(safeSpawnAsync.mock.calls[0]?.[1]).toEqual(
				expect.arrayContaining(["--indent-width", "2"]),
			);
		} finally {
			env.cleanup();
		}
	});

	it("declines formatter style for ambiguous nested-only indentation", async () => {
		const env = setupTestEnvironment("pi-lens-format-indent-ambiguous-");
		try {
			writeBiomeEvidence(env.tmpDir);
			const filePath = path.join(env.tmpDir, "nested-only.ts");
			fs.writeFileSync(filePath, "      nested\n            deeper\n");

			const service = new FormatService("format-indent-ambiguous", true);
			service.recordRead(filePath);
			const summary = await service.formatFile(filePath);

			expect(summary.formatters).toEqual([
				expect.objectContaining({ name: "biome", outcome: "skipped" }),
			]);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("honors an ancestor editorconfig through the selected formatter", async () => {
		const env = setupTestEnvironment("pi-lens-format-indent-config-");
		try {
			writeBiomeEvidence(env.tmpDir);
			fs.writeFileSync(path.join(env.tmpDir, ".editorconfig"), "root = true\n");
			const nested = path.join(env.tmpDir, "packages", "app");
			fs.mkdirSync(nested, { recursive: true });
			const filePath = path.join(nested, "values.ts");
			fs.writeFileSync(filePath, fixture);
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const service = new FormatService("format-indent-config", true);
			service.recordRead(filePath);
			await service.formatFile(filePath);

			expect(safeSpawnAsync).toHaveBeenCalledWith(
				expect.any(String),
				expect.arrayContaining(["--use-editorconfig=true"]),
				expect.anything(),
			);
			expect(safeSpawnAsync.mock.calls[0]?.[1]).not.toContain("--indent-width");
		} finally {
			env.cleanup();
		}
	});
});
