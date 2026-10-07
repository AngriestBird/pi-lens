/**
 * #3913: the review graph's worker persist stores the body it was sent, and the
 * worker's string chunker must not split a surrogate pair across two 256 KiB
 * chunks (each chunk is encoded on its own, so a split pair became two U+FFFD).
 *
 * Recurrences these tests prevent:
 *  - a graph body that puts a surrogate pair on a chunk boundary is stored with
 *    replacement characters, and the load path then reads a different graph;
 *  - the chunker fix changes bytes for bodies that do not straddle: the corpus
 *    proves the persist and checkpoint bodies equal the ones `ca7e89066` wrote.
 *
 * Fixture corpus: tests/fixtures/review-graph-persist/released-ca7e89066
 * (written by ca7e89066, before the chunker fix).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersist,
	resetReviewGraphPersistWorkerForTests,
	reviewGraphCachePath,
	terminateReviewGraphPersistWorkerForTests,
	waitForReviewGraphPersistsForTests,
} from "../../clients/review-graph/builder.js";
import {
	CORPUS_CHECKPOINT_EVERY_FILES,
	CORPUS_FILES,
	CORPUS_MTIME_SECONDS,
	// @ts-expect-error -- bare-node fixture module, no declaration file
} from "../fixtures/review-graph-persist/corpus-project.mjs";
import { setupTestEnvironment } from "./test-utils.js";

const CORPUS = path.join(
	import.meta.dirname,
	"../fixtures/review-graph-persist/released-ca7e89066",
);
const CHUNK = 256 * 1024;

const cleanups: Array<() => void> = [];

beforeEach(() => {
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES;
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS;
	resetReviewGraphPersistWorkerForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await waitForReviewGraphPersistsForTests();
	await terminateReviewGraphPersistWorkerForTests();
	resetReviewGraphPersistWorkerForTests();
	clearReviewGraphWorkspaceCache();
	clearGraphCache();
	while (cleanups.length) cleanups.pop()?.();
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES;
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS;
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
});

function makeProject(files: Record<string, string>): string {
	const env = setupTestEnvironment("pi-lens-graph-body-");
	cleanups.push(env.cleanup);
	const cwd = fs.realpathSync(env.tmpDir);
	for (const [relative, content] of Object.entries(files)) {
		const file = path.join(cwd, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		fs.utimesSync(file, CORPUS_MTIME_SECONDS, CORPUS_MTIME_SECONDS);
	}
	return cwd;
}

type Site = "persist" | "checkpoint";
const siteOf = (stagePath: string): Site =>
	path.basename(stagePath).includes(".checkpoint.") ? "checkpoint" : "persist";

/** Copies each body the worker staged, before the main thread promotes it. */
function captureStages(): Array<{ site: Site; body: string }> {
	const stages: Array<{ site: Site; body: string }> = [];
	const realOn = Worker.prototype.on;
	vi.spyOn(Worker.prototype, "on").mockImplementation(function (
		this: Worker,
		event: string,
		listener: (...args: unknown[]) => void,
	) {
		if (event !== "message") return realOn.call(this, event, listener);
		return realOn.call(this, event, (result: { stagePath: string }) => {
			if (fs.existsSync(result.stagePath)) {
				stages.push({
					site: siteOf(result.stagePath),
					body: gunzipSync(fs.readFileSync(result.stagePath)).toString("utf-8"),
				});
			}
			listener(result);
		});
	} as typeof Worker.prototype.on);
	return stages;
}

const mask = (body: string, root: string): string =>
	body
		.replaceAll(root, "<root>")
		.replace(/"builtAt":"[^"]*"/g, '"builtAt":"<masked>"');

const fixture = (name: string): string =>
	fs.readFileSync(path.join(CORPUS, name), "utf-8");

/**
 * The graph body puts a high surrogate at index CHUNK - 1; the test compares
 * the worker's stored body to the main-thread body of the same graph.
 */
describe("a surrogate pair on a chunk boundary survives the worker persist (#3913)", () => {
	const astralName = (seed: number): string =>
		Array.from({ length: 100 }, (_, i) =>
			String.fromCodePoint(0x20000 + ((seed * 37 + i) % 5000)),
		).join("");
	const straddlingSource = (functions: number, pad: number): string =>
		[
			`export function pad${"p".repeat(pad)}() { return 0; }`,
			...Array.from(
				{ length: functions },
				(_, i) => `export function f${i}${astralName(i)}() { return ${i}; }`,
			),
		].join("\n");
	const straddles = (body: string): boolean => {
		for (let at = CHUNK - 1; at < body.length; at += CHUNK) {
			const unit = body.charCodeAt(at);
			if (unit >= 0xd800 && unit <= 0xdbff) return true;
		}
		return false;
	};

	/** The body `flushReviewGraphPersist` writes on the main thread (no chunker). */
	async function mainThreadBody(cwd: string): Promise<string> {
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
		await buildOrUpdateGraph(cwd, [], new FactStore());
		expect(flushReviewGraphPersist(cwd).ok).toBe(true);
		const body = gunzipSync(
			fs.readFileSync(reviewGraphCachePath(cwd)),
		).toString("utf-8");
		fs.rmSync(reviewGraphCachePath(cwd));
		clearReviewGraphWorkspaceCache(cwd);
		clearGraphCache();
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		return body;
	}

	it("stores the same body the main thread writes, with no replacement characters", async () => {
		const stages = captureStages();
		// Size the graph so its body runs past one chunk: measure two sizes, then
		// aim a little beyond CHUNK so the boundary falls inside the function nodes.
		const sizeAt = async (functions: number): Promise<number> =>
			(
				await mainThreadBody(
					makeProject({ "src/a.ts": straddlingSource(functions, 0) }),
				)
			).length;
		const small = await sizeAt(100);
		const large = await sizeAt(300);
		const perFunction = (large - small) / 200;
		const functions = Math.ceil(100 + (CHUNK + 30_000 - small) / perFunction);

		// Shifting everything after the pad function by one unit moves which
		// character sits on the boundary, so some pad length puts a high
		// surrogate there. Each probe is deterministic for a given temp root.
		let found: { cwd: string; truth: string } | undefined;
		for (let pad = 0; pad < 80 && found === undefined; pad++) {
			const cwd = makeProject({
				"src/a.ts": straddlingSource(functions, pad),
			});
			const truth = await mainThreadBody(cwd);
			if (straddles(truth)) found = { cwd, truth };
		}
		expect(
			found,
			"no pad length put a high surrogate on the boundary",
		).toBeDefined();
		const { cwd, truth } = found as { cwd: string; truth: string };
		expect(truth.length).toBeGreaterThan(CHUNK);

		stages.length = 0;
		await buildOrUpdateGraph(cwd, [], new FactStore());
		await waitForReviewGraphPersistsForTests();

		const staged = stages.filter((stage) => stage.site === "persist");
		expect(staged).toHaveLength(1);
		expect(staged[0].body).not.toContain("�");
		expect(mask(staged[0].body, cwd)).toBe(mask(truth, cwd));
	}, 120_000);
});

describe("released-writer corpus (#3913)", () => {
	it("writes the persist body the released code wrote", async () => {
		const cwd = makeProject(CORPUS_FILES);
		const stages = captureStages();

		await buildOrUpdateGraph(cwd, [], new FactStore());
		await waitForReviewGraphPersistsForTests();

		const staged = stages.filter((stage) => stage.site === "persist");
		expect(staged).toHaveLength(1);
		expect(mask(staged[0].body, cwd)).toBe(fixture("persist-body.json"));
		// Non-BMP characters in a path and a symbol name are in the corpus.
		expect(staged[0].body).toContain("😀");
	});

	it("writes the checkpoint body the released code wrote", async () => {
		const cwd = makeProject(CORPUS_FILES);
		process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES =
			CORPUS_CHECKPOINT_EVERY_FILES;
		process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS = "0";
		const stages = captureStages();

		await buildOrUpdateGraph(cwd, [], new FactStore());
		await waitForReviewGraphPersistsForTests();

		// Both strides reach the worker; their results arrive in either order.
		const firstStride = stages.find(
			(stage) =>
				stage.site === "checkpoint" &&
				(JSON.parse(stage.body) as { processedFiles: unknown[] }).processedFiles
					.length === 2,
		);
		expect(firstStride).toBeDefined();
		expect(mask(firstStride?.body ?? "", cwd)).toBe(
			fixture("checkpoint-body.json"),
		);
	});
});
