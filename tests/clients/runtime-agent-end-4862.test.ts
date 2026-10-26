import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { resetSessionScopedState } from "../../clients/runtime-session.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Same process-boundary pattern as pipeline-changed-identity-4689.test.ts:
// the real Dart fixer/restore path runs, but no installed Dart or network is needed.
const fake = vi.hoisted(() => ({ dartFix: vi.fn<(cwd: string) => void>() }));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: vi.fn(
			async (
				command: string,
				args: readonly string[],
				options?: Parameters<typeof actual.safeSpawnAsync>[2],
			) => {
				// The fixture's .git is a root marker, not an initialized repository.
				if (command === "git" && args[0] === "ls-files") {
					return { stdout: "", stderr: "not a git repository", status: 128 };
				}
				if (command === "dart" && args[0] === "--version") {
					return { stdout: "Dart SDK version: 3.5.0", stderr: "", status: 0 };
				}
				if (command === "dart" && args.join(" ") === "fix --apply") {
					fake.dartFix(options?.cwd ?? "");
					return { stdout: "", stderr: "", status: 0 };
				}
				throw new Error(`Unexpected subprocess: ${command} ${args.join(" ")}`);
			},
		),
	};
});

describe("deferred autofix scope (#4862)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let runtime: RuntimeCoordinator;

	beforeEach(() => {
		const fixture = setupTestEnvironment("pi-lens-agent-end-4862-");
		// Match formatters-format-file.test.ts: macOS /var may alias /private/var.
		env = { ...fixture, tmpDir: fs.realpathSync(fixture.tmpDir) };
		resetSessionScopedState(env.tmpDir);
		resetDegradationLedger();
		runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		fake.dartFix.mockReset();
		// Real sink, in the worker's hermetic home; no spy on the record seam.
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
	});

	afterEach(async () => {
		await flushLatencyLog();
		resetSessionScopedState(env.tmpDir);
		resetDegradationLedger();
		vi.unstubAllEnvs();
		env.cleanup();
	});

	function queue(files: string[]): void {
		for (const file of files) {
			runtime.deferMutation(file, env.tmpDir, "edit", env.tmpDir, "autofix");
		}
	}

	function drain(biomeClient: BiomeClient) {
		return handleAgentEnd({
			ctxCwd: env.tmpDir,
			getFlag: (name) => name === "no-lsp",
			notify: vi.fn(),
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient,
			ruffClient: {} as never,
			getFormatService: () => {
				throw new Error("Autofix-only records must not format");
			},
		});
	}

	// Recurrence: JS/TS's accidental cargo-project scope ran Biome only for
	// the first file. Keep policy, queue, handler and runAutofix real; double
	// only the Biome boundary, as runtime-agent-end.test.ts already does.
	it("applies deferred Biome fixes to both edited TypeScript files in one project", async () => {
		createTempFile(env.tmpDir, "biome.json", "{}\n");
		createTempFile(
			env.tmpDir,
			"package.json",
			JSON.stringify({ devDependencies: { "@biomejs/biome": "1.0.0" } }),
		);
		createTempFile(
			env.tmpDir,
			"package-lock.json",
			JSON.stringify({
				packages: { "node_modules/@biomejs/biome": { version: "1.0.0" } },
			}),
		);
		const files = ["a", "b"].map((name) =>
			createTempFile(env.tmpDir, `src/${name}.ts`, `let ${name} = 1;\n`),
		);
		const fixFileAsync = vi.fn(async (filePath: string) => {
			const before = fs.readFileSync(filePath, "utf8");
			fs.writeFileSync(filePath, before.replace("let ", "const "));
			return { success: true, changed: true, fixed: 1 };
		});
		queue(files);

		const result = await drain({
			isSupportedFile: () => true,
			ensureAvailable: async () => true,
			fixFileAsync,
		} as unknown as BiomeClient);

		expect(files.map((file) => fs.readFileSync(file, "utf8"))).toEqual([
			"const a = 1;\n",
			"const b = 1;\n",
		]);
		expect(fixFileAsync.mock.calls.map(([file]) => file)).toEqual(files);
		expect(result?.failed).toEqual([]);
		expect(runtime.pendingDeferredFormatCount).toBe(0);
	});

	// Recurrence: a duplicate scope used to silently continue. More than one
	// duplicate, then another drain, must still leave ONE record per scope in
	// this session, not one per file or drain; Dart still runs once per drain.
	it("keeps Dart project dedupe and records duplicate-scope skips exactly once across drains", async () => {
		createTempFile(
			env.tmpDir,
			"pubspec.yaml",
			"name: fixture\nenvironment:\n  sdk: ^3.0.0\n",
		);
		const files = ["a", "b", "c"].map((name) =>
			createTempFile(
				env.tmpDir,
				`lib/${name}.dart`,
				"void main() { var x = 1; }\n",
			),
		);
		fake.dartFix.mockImplementation((cwd) => {
			expect(cwd).toBe(fs.realpathSync(env.tmpDir));
			for (const file of files) {
				fs.writeFileSync(file, "void main() { final x = 1; }\n");
			}
		});

		for (let turn = 0; turn < 2; turn++) {
			runtime.fixedThisTurn.clear();
			for (const file of files) {
				fs.writeFileSync(file, "void main() { var x = 1; }\n");
			}
			queue(files);
			const result = await drain({} as BiomeClient);
			expect(result?.failed).toEqual([]);
			expect(runtime.pendingDeferredFormatCount).toBe(0);
			expect(fake.dartFix).toHaveBeenCalledTimes(turn + 1);
			for (const file of files) {
				expect(fs.readFileSync(file, "utf8")).toBe(
					"void main() { final x = 1; }\n",
				);
			}
			await flushLatencyLog();
			const { rows, skipped } = readNdjsonRows(getLatencyLogPath());
			expect(skipped).toBe(0);
			const skips = rows.filter((row) => {
				const metadata = row.metadata as Record<string, unknown> | undefined;
				return (
					row.phase === "degradation_ledger" &&
					metadata?.kind === "deferred-autofix-duplicate-scope" &&
					metadata.subject === `dart-analyze:${path.resolve(env.tmpDir)}`
				);
			});
			expect(skips).toHaveLength(1);
			expect(skips[0]?.metadata).toMatchObject({
				subject: `dart-analyze:${path.resolve(env.tmpDir)}`,
				tool: "dart-analyze",
				scope: "dart-project",
				filePath: files[1],
				reason: "duplicate-scope",
				count: 1,
			});
		}
	});
});
