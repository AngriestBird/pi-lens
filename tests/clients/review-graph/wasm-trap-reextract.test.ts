/**
 * #3605 review F2: a file a one-off web-tree-sitter trap cost must be
 * re-extracted by the next build, whichever path that build takes. Round 1
 * committed the trapped file as zero symbols, and the seq fast path, a restart
 * from the persisted graph and a resumed checkpoint all reused it while the
 * file was unchanged. The in-memory path is pinned in
 * wasm-trap-containment.test.ts. These cases live in their own file because
 * each trap spends one unit of the process budget (`WASM_TRAP_BUDGET`, 3),
 * and vitest gives each file a fresh process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWebTreeSitter } from "../../../clients/deps/web-tree-sitter.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getGraphBuildInfoForGraph,
} from "../../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

vi.mock("../../../clients/lsp-document-symbols.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/lsp-document-symbols.js")
	>()),
	getOpenDocumentSymbols: vi.fn().mockResolvedValue(null),
}));

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};

const cleanups: Array<() => void> = [];
beforeEach(() => {
	// Persist only when a test flushes.
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
});
afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
	delete process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS;
	flushReviewGraphPersistsForTests();
	clearReviewGraphWorkspaceCache();
	clearGraphCache();
	while (cleanups.length) cleanups.pop()?.();
});

/** A trap is charged to its input, so each test gives b.py its own content. */
function pythonProject(tag: number): { tmpDir: string; files: string[] } {
	const env = setupTestEnvironment("pi-lens-wasm-reextract-");
	cleanups.push(env.cleanup);
	const files = [
		createTempFile(env.tmpDir, "a.py", "def alpha_fn():\n    return 1\n"),
		createTempFile(
			env.tmpDir,
			"b.py",
			`def trap_here_fn():\n    return ${tag}\n`,
		),
		createTempFile(env.tmpDir, "c.py", "def gamma_fn():\n    return 3\n"),
	];
	return { tmpDir: env.tmpDir, files };
}

/** Trap b.py's first symbol query once, at the production throw site. */
async function trapOnce(): Promise<void> {
	const { Query } = await loadWebTreeSitter();
	const realMatches = Query.prototype.matches;
	let traps = 1;
	vi.spyOn(Query.prototype, "matches").mockImplementation(function (
		this: InstanceType<typeof Query>,
		...args: Parameters<typeof realMatches>
	) {
		if (args[0].text.includes("trap_here") && traps-- > 0) {
			throw new WebAssembly.RuntimeError("table index is out of bounds");
		}
		return realMatches.apply(this, args);
	});
}

function symbolNames(graph: Awaited<ReturnType<typeof buildOrUpdateGraph>>) {
	return [...graph.nodes.values()]
		.map((node) => node.symbolName)
		.filter((name): name is string => name !== undefined);
}

describe("a one-off trap is retried on every build path (#3605 F2)", () => {
	it("re-extracts the file after a restart from the persisted graph", async () => {
		const { tmpDir, files } = pythonProject(21);
		await trapOnce();
		const trapped = await buildOrUpdateGraph(tmpDir, files, new FactStore());
		expect(symbolNames(trapped)).not.toContain("trap_here_fn");

		flushReviewGraphPersistsForTests();
		clearReviewGraphWorkspaceCache();
		const restarted = await buildOrUpdateGraph(tmpDir, [], new FactStore());

		expect(getGraphBuildInfoForGraph(restarted).mode).toBe("incremental");
		expect(symbolNames(restarted)).toContain("trap_here_fn");
	});

	it("re-extracts the file on a seq fast-path build that names no change", async () => {
		const { tmpDir, files } = pythonProject(22);
		const seqHint = {
			projectSeq: () => 0,
			getFilesChangedSince: (): string[] => [],
		};
		await trapOnce();
		await buildOrUpdateGraph(tmpDir, files, new FactStore(), seqHint);

		const next = await buildOrUpdateGraph(
			tmpDir,
			[],
			new FactStore(),
			seqHint,
		);

		expect(getGraphBuildInfoForGraph(next).mode).toBe("seq-fastpath");
		expect(symbolNames(next)).toContain("trap_here_fn");
	});

	it("re-extracts the file when a killed build resumes from its checkpoint", async () => {
		const { tmpDir, files } = pythonProject(23);
		await trapOnce();
		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER = String(
			files.length,
		);
		await expect(
			buildOrUpdateGraph(tmpDir, files, new FactStore()),
		).rejects.toThrow(/checkpoint_test_abort/);

		delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
		clearReviewGraphWorkspaceCache();
		clearGraphCache();
		const resumed = await buildOrUpdateGraph(tmpDir, [], new FactStore());

		expect(symbolNames(resumed)).toContain("trap_here_fn");
	});
});
