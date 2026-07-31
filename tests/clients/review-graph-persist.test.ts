import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	_resetReviewGraphBuildAttemptsForTests,
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersist,
	flushReviewGraphPersistsForTests,
	getCachedReviewGraph,
	getLastReviewGraphBuildAttempt,
	getReviewGraphWorkerFallbackReasonForTests,
	GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT,
	resetReviewGraphPersistWorkerForTests,
	terminateReviewGraphPersistWorkerForTests,
	waitForReviewGraphPersistsForTests,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Circuit-breaker for the review-graph persist (#260): the whole-graph
// JSON.stringify on every edit turn spiked the host into a Zone OOM. These cover
// the two guards — element-count ceiling (skip) and debounce (coalesce/defer).

const cleanups: Array<() => void> = [];
afterEach(async () => {
	flushReviewGraphPersistsForTests(); // drain any pending debounced write/timer
	await waitForReviewGraphPersistsForTests();
	resetReviewGraphPersistWorkerForTests();
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
	_resetReviewGraphBuildAttemptsForTests();
	// Restore the test-default synchronous persist + uncapped size.
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
	delete process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS;
	delete process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS;
});

function makeEnv() {
	const env = setupTestEnvironment("pi-lens-graph-persist-");
	cleanups.push(env.cleanup);
	return env;
}

function cachePathFor(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "review-graph.json.gz");
}

async function waitForFile(p: string, attempts = 20): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		if (fs.existsSync(p)) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return fs.existsSync(p);
}

describe("review-graph persist circuit-breaker (#260)", () => {
	it("defaults to the measured 500,000-element ceiling (#936)", () => {
		expect(GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT).toBe(500_000);
	});

	it("size cap: persists an honestly-marked useful partial graph", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "a.ts", "export function foo() {\n  return 1;\n}\n");
		createTempFile(
			env.tmpDir,
			"b.ts",
			'import { foo } from "./a.js";\nexport const r = foo();\n',
		);
		const cachePath = cachePathFor(env.tmpDir);
		// A two-file project is well above 1 element (file + symbol nodes + edges).
		process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = "4";

		const built = await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts"), path.join(env.tmpDir, "b.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		expect(await waitForFile(cachePath)).toBe(true);
		await waitForReviewGraphPersistsForTests();
		const raw = JSON.parse(
			gunzipSync(fs.readFileSync(cachePath)).toString("utf-8"),
		);
		expect(raw.coverage).toEqual({
			partial: true,
			cap: 4,
			totalNodes: built.nodes.size,
			totalEdges: built.edges.length,
			persistedNodes: raw.nodes.length,
			persistedEdges: raw.edges.length,
		});
		expect(raw.nodes.length + raw.edges.length).toBeLessThanOrEqual(4);
		expect(raw.nodes.length).toBeGreaterThan(0);
		expect(
			raw.nodes.some(
				([, node]: [string, { filePath?: string }]) =>
					node.filePath?.endsWith("/a.ts") ||
					node.filePath?.endsWith("\\a.ts"),
			),
		).toBe(true);
		const attempt = getLastReviewGraphBuildAttempt(env.tmpDir);
		expect(attempt).toMatchObject({ outcome: "succeeded" });
		expect(attempt?.reason).toMatch(/persisted partial review graph \(\d+\/\d+ elements/);
	});

	it("round-trips partial coverage without presenting it as complete", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "hot.ts", "export function hot() { return 1 }\n");
		createTempFile(
			env.tmpDir,
			"user.ts",
			'import { hot } from "./hot.js";\nexport const used = hot();\n',
		);
		process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = "4";
		const built = await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "hot.ts"), path.join(env.tmpDir, "user.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		await waitForReviewGraphPersistsForTests();

		clearReviewGraphWorkspaceCache(env.tmpDir);
		const loaded = getCachedReviewGraph(env.tmpDir);
		expect(loaded?.persistCoverage).toMatchObject({
			partial: true,
			cap: 4,
			totalNodes: built.nodes.size,
			totalEdges: built.edges.length,
		});
		expect(loaded?.persistCoverage?.persistedNodes).toBe(loaded?.nodes.size);
		expect(loaded?.persistCoverage?.persistedEdges).toBe(loaded?.edges.length);
		expect((loaded?.nodes.size ?? 0) + (loaded?.edges.length ?? 0)).toBeLessThanOrEqual(4);
	});

	it("size cap: writes normally when under the ceiling", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "a.ts", "export function foo() {\n  return 1;\n}\n");
		const cachePath = cachePathFor(env.tmpDir);
		process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = "1000000";

		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		expect(await waitForFile(cachePath)).toBe(true);
	});

	it("debounce: defers the write until the quiet window / flush", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "a.ts", "export function foo() {\n  return 1;\n}\n");
		const cachePath = cachePathFor(env.tmpDir);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000"; // effectively never

		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		await new Promise((r) => setTimeout(r, 60));
		// Scheduled but not yet flushed → no file on disk.
		expect(fs.existsSync(cachePath)).toBe(false);

		flushReviewGraphPersistsForTests();
		expect(await waitForFile(cachePath)).toBe(true);
	});

	it("worker gzip round-trips through the load path", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function alpha() { return 1 }\nexport const beta = alpha();\n",
		);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		const built = await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		await waitForReviewGraphPersistsForTests();
		expect(fs.readFileSync(cachePathFor(env.tmpDir)).subarray(0, 2)).toEqual(
			Buffer.from([0x1f, 0x8b]),
		);

		clearReviewGraphWorkspaceCache(env.tmpDir);
		const loaded = getCachedReviewGraph(env.tmpDir);
		expect(loaded?.nodes.size).toBe(built.nodes.size);
		expect(loaded?.edges).toEqual(built.edges);
	});

	it("loads a legacy uncompressed v7 snapshot when gzip is absent", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "legacy.ts", "export const legacy = 1;\n");
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000";
		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "legacy.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		const gzipPath = cachePathFor(env.tmpDir);
		const legacyPath = path.join(path.dirname(gzipPath), "review-graph.json");
		fs.writeFileSync(legacyPath, gunzipSync(fs.readFileSync(gzipPath)));
		fs.rmSync(gzipPath);
		clearReviewGraphWorkspaceCache(env.tmpDir);

		expect(getCachedReviewGraph(env.tmpDir)?.nodes.size).toBeGreaterThan(0);
	});

	it("sync flush supersedes an older in-flight worker generation", async () => {
		const env = makeEnv();
		const sourcePath = createTempFile(
			env.tmpDir,
			"a.ts",
			"export const oldValue = 1;\n",
		);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		const oldGraph = await buildOrUpdateGraph(
			env.tmpDir,
			[sourcePath],
			new FactStore(),
		);
		const oldNodeCount = oldGraph.nodes.size;
		const secondPath = createTempFile(
			env.tmpDir,
			"b.ts",
			"export const newValue = 2;\n",
		);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000";
		const newGraph = await buildOrUpdateGraph(
			env.tmpDir,
			[sourcePath, secondPath],
			new FactStore(),
		);
		expect(newGraph.nodes.size).toBeGreaterThan(oldNodeCount);
		expect(flushReviewGraphPersist(env.tmpDir).ok).toBe(true);
		await waitForReviewGraphPersistsForTests();
		clearReviewGraphWorkspaceCache(env.tmpDir);
		expect(getCachedReviewGraph(env.tmpDir)?.nodes.size).toBe(newGraph.nodes.size);
	});

	it("worker death degrades to a logged main-thread persist", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "a.ts", "export const fallback = 1;\n");
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS = "1000";
		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		await terminateReviewGraphPersistWorkerForTests();
		await waitForReviewGraphPersistsForTests();
		expect(fs.existsSync(cachePathFor(env.tmpDir))).toBe(true);
		expect(getReviewGraphWorkerFallbackReasonForTests()).toMatch(
			/exited|unavailable/,
		);
	});
});
