/**
 * #766: how `DependencyChecker` resolves the madge command.
 *
 * Resolution used to fall straight from `findNodeToolBinary` to `npx madge`,
 * never consulting the tools tree pi-lens itself installs madge into — so an
 * environment whose ONLY madge is the managed one paid npx module resolution on
 * every spawn, and it ran once per file inside the batch mapper (each miss
 * re-walking node_modules and re-spawning the uncached `npm config get prefix` /
 * `pnpm bin -g` global probes).
 *
 * These tests pin the resolution ORDER, that the discovery step can never
 * install, that `kind` is classified from the resolved string rather than the
 * step that produced it, and that the whole chain runs once per project root.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const findNodeToolBinary = vi.fn();
const ensureTool = vi.fn();
const MANAGED_TOOLS_DIR = path.join(os.tmpdir(), "pilens-fake-home", "tools");

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/package-manager.js", () => ({ findNodeToolBinary }));
vi.mock("../../clients/installer/index.js", () => ({
	ensureTool,
	getManagedToolsDir: () => MANAGED_TOOLS_DIR,
}));

describe("DependencyChecker madge resolution (#766)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetAllMocks();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-madge-resolve-"));
		findNodeToolBinary.mockResolvedValue(undefined);
		ensureTool.mockResolvedValue(undefined);
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") {
				return { status: 0, error: null, stdout: "madge 8.0.0", stderr: "" };
			}
			return { status: 0, error: null, stdout: "[]", stderr: "" };
		});
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	function writeSource(name: string, imports: string[]): string {
		const file = path.join(tmp, name);
		fs.writeFileSync(
			file,
			`${imports.map((i) => `import { x } from "${i}";`).join("\n")}\nexport const v = 1;\n`,
		);
		return file;
	}

	/** The madge spawns, excluding `ensureAvailable`'s `--version` probe. */
	function madgeCalls(): unknown[][] {
		return safeSpawnAsync.mock.calls.filter(
			(c) => (c[1] as string[])[0] !== "--version",
		);
	}

	it("keeps a project-local/global binary winning (#375), without consulting the installer", async () => {
		const { DependencyChecker } = await import(
			"../../clients/dependency-checker.js"
		);
		findNodeToolBinary.mockResolvedValue("/fake/bin/madge");

		const { stats } = await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);

		expect(stats.commandKind).toBe("local");
		expect(ensureTool).not.toHaveBeenCalled();
		expect(madgeCalls()[0][0]).toBe("/fake/bin/madge");
	});

	it("uses the managed install instead of npx when nothing local is found", async () => {
		const { DependencyChecker } = await import(
			"../../clients/dependency-checker.js"
		);
		const managed = path.join(
			MANAGED_TOOLS_DIR,
			"node_modules",
			".bin",
			"madge",
		);
		ensureTool.mockResolvedValue(managed);

		const { stats } = await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);

		expect(stats.commandKind).toBe("managed");
		const [cmd, args] = madgeCalls()[0] as [string, string[]];
		expect(cmd).toBe(managed);
		// No `npx madge` prefix — the binary is invoked directly.
		expect(args[0]).toBe("--circular");
	});

	it("classifies the resolved STRING, not the step that produced it", async () => {
		const { DependencyChecker } = await import(
			"../../clients/dependency-checker.js"
		);

		// The installer's discovery can hand back a bare PATH name...
		ensureTool.mockResolvedValue("madge");
		const bare = await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);
		expect(bare.stats.commandKind).toBe("path");

		// ...or an absolute path outside the managed tree.
		ensureTool.mockResolvedValue(path.join(path.sep, "usr", "bin", "madge"));
		const global = await new DependencyChecker().checkFilesBatch(
			[writeSource("b.ts", ["./c.js"])],
			tmp,
		);
		expect(global.stats.commandKind).toBe("global");
	});

	it("falls back to `npx madge` only when nothing is discoverable", async () => {
		const { DependencyChecker } = await import(
			"../../clients/dependency-checker.js"
		);

		const { stats } = await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);

		expect(stats.commandKind).toBe("npx");
		const [cmd, args] = madgeCalls()[0] as [string, string[]];
		expect(cmd).toBe("npx");
		expect(args[0]).toBe("madge");
	});

	it("never installs from the spawn path", async () => {
		const { DependencyChecker } = await import(
			"../../clients/dependency-checker.js"
		);

		await new DependencyChecker().checkFilesBatch(
			[writeSource("a.ts", ["./b.js"])],
			tmp,
		);

		// Installation stays owned by ensureAvailable(); discovery here must not
		// be able to trigger a download.
		expect(ensureTool).toHaveBeenCalledWith("madge", { allowInstall: false });
	});

	it("resolves once per project root, not once per file or once per batch", async () => {
		const { DependencyChecker } = await import(
			"../../clients/dependency-checker.js"
		);
		const files = [
			writeSource("a.ts", ["./x.js"]),
			writeSource("b.ts", ["./y.js"]),
			writeSource("c.ts", ["./z.js"]),
		];

		const checker = new DependencyChecker();
		const first = await checker.checkFilesBatch(files, tmp);
		expect(madgeCalls()).toHaveLength(3);

		// Re-edit the imports so the second batch is three fresh misses.
		files.forEach((f, i) =>
			fs.writeFileSync(
				f,
				`import { x } from "./x${i}.js";\nimport { y } from "./y${i}.js";\nexport const v = 1;\n`,
			),
		);
		const second = await checker.checkFilesBatch(files, tmp);

		expect(madgeCalls()).toHaveLength(6);
		expect(findNodeToolBinary).toHaveBeenCalledTimes(1);
		expect(ensureTool).toHaveBeenCalledTimes(1);
		expect(first.stats.resolveMs).toBeGreaterThanOrEqual(0);
		expect(second.stats.commandKind).toBe("npx");
	});
});
