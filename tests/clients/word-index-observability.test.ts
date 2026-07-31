/**
 * #958 durable word-index observability — asserts the structured signals the
 * audit flagged as missing are EMITTED at their source (independent of the
 * host's `dbg`, which is a no-op in the MCP host):
 *   - L1: `collectWordIndexDocs` reports a `skipped` count for files it saw but
 *     could not index (over the byte cap / unreadable), so coverage stays
 *     honest (#533) instead of a silent drop.
 *   - M2: the cold-query background build logs its decision + coverage
 *     (indexedFileCount / truncated / skipped).
 *   - M3: a swallowed snapshot persist emits a `persist_failed` record.
 *   - The safety refusal (root at/above $HOME) is durably recorded too.
 *
 * `logWordIndex` is mocked with a spy so the assertions read the exact entries
 * the production code hands the durable logger, without touching disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
const { failPersist } = vi.hoisted(() => ({ failPersist: { value: false } }));

vi.mock("../../clients/word-index-logger.js", () => ({
	logWordIndex: logSpy,
	getWordIndexLogPath: () => "/dev/null/word-index.log",
	flushWordIndexLog: vi.fn().mockResolvedValue(undefined),
	flushWordIndexLogSync: vi.fn(),
}));

vi.mock("../../clients/project-snapshot.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../clients/project-snapshot.js")>();
	return {
		...actual,
		default: actual,
		saveProjectSnapshot: (...args: unknown[]) => {
			if (failPersist.value) throw new Error("ENOSPC: no space left on device");
			return (actual.saveProjectSnapshot as (...a: unknown[]) => unknown)(...args);
		},
	};
});

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
	logSpy.mockClear();
	failPersist.value = false;
	process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS = "0";
});
afterEach(async () => {
	const { flushWordIndexPersistsForTests, _resetWordIndexBuildGuardForTests } =
		await import("../../clients/word-index.js");
	flushWordIndexPersistsForTests();
	_resetWordIndexBuildGuardForTests();
	delete process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS;
	vi.restoreAllMocks();
});

describe("word-index observability (#958)", () => {
	it("L1: collectWordIndexDocs counts oversized + unreadable files as skipped, keeping coverage honest", async () => {
		const env = setupTestEnvironment("pi-lens-word-skip-");
		try {
			const { collectWordIndexDocs, WORD_INDEX_MAX_BYTES } = await import(
				"../../clients/word-index.js"
			);
			createTempFile(env.tmpDir, "src/small.ts", "export const kept = 1;");
			createTempFile(
				env.tmpDir,
				"src/huge.ts",
				`// x\nexport const big = "${"z".repeat(WORD_INDEX_MAX_BYTES + 16)}";\n`,
			);

			const docs = await collectWordIndexDocs(env.tmpDir);

			// The small file is indexed; the oversized file is NOT — but it is
			// COUNTED, not silently dropped.
			expect(docs.some((d) => d.path.endsWith("small.ts"))).toBe(true);
			expect(docs.some((d) => d.path.endsWith("huge.ts"))).toBe(false);
			expect(docs.skipped).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("M3: a swallowed persist failure emits a persist_failed record (every later query would read stale)", async () => {
		const env = setupTestEnvironment("pi-lens-word-persist-fail-");
		try {
			const { buildWordIndex, scheduleWordIndexPersist, flushWordIndexPersistsForTests } =
				await import("../../clients/word-index.js");
			const index = buildWordIndex([
				{ path: "a.ts", content: "export const alpha = 1;" },
			]);

			failPersist.value = true;
			scheduleWordIndexPersist(env.tmpDir, index);
			flushWordIndexPersistsForTests();
			await flushMicrotasks();

			const persistFailed = logSpy.mock.calls.find(
				(c) => c[0]?.phase === "persist_failed",
			);
			expect(persistFailed).toBeDefined();
			expect(persistFailed?.[0]).toEqual(
				expect.objectContaining({
					phase: "persist_failed",
					trigger: "per_edit",
					indexedFileCount: 1,
					error: expect.stringContaining("ENOSPC"),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("M2: the cold-query background build logs its decision + honest coverage", async () => {
		const env = setupTestEnvironment("pi-lens-word-cold-");
		try {
			createTempFile(env.tmpDir, "src/widget.ts", "export const renderWidget = 1;");
			const { triggerBackgroundWordIndexBuild } = await import(
				"../../clients/word-index.js"
			);

			triggerBackgroundWordIndexBuild(env.tmpDir);
			await flushMicrotasks();

			const coldBuild = logSpy.mock.calls.find(
				(c) => c[0]?.phase === "cold_build",
			);
			expect(coldBuild).toBeDefined();
			expect(coldBuild?.[0]).toEqual(
				expect.objectContaining({
					phase: "cold_build",
					trigger: "cold_query",
					truncated: false,
					skipped: 0,
				}),
			);
			expect(coldBuild?.[0].indexedFileCount).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	it("records the safety refusal when the root is at/above $HOME", async () => {
		const env = setupTestEnvironment("pi-lens-word-refused-");
		try {
			const { triggerBackgroundWordIndexBuild } = await import(
				"../../clients/word-index.js"
			);
			// homeDir == the build root ⇒ isAtOrAboveHomeDir refuses.
			const status = triggerBackgroundWordIndexBuild(env.tmpDir, undefined, {
				homeDir: env.tmpDir,
			});

			expect(status.state).toBe("refused");
			const refused = logSpy.mock.calls.find(
				(c) => c[0]?.phase === "cold_build_refused",
			);
			expect(refused).toBeDefined();
			expect(refused?.[0]).toEqual(
				expect.objectContaining({
					phase: "cold_build_refused",
					trigger: "cold_query",
				}),
			);
		} finally {
			env.cleanup();
		}
	});
});
