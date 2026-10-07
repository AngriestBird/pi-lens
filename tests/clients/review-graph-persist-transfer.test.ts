/**
 * #3913 (follow-up of #3789): the review graph's two worker-persist sites hand
 * the worker serialized bytes, not the graph. Before, `writePending` and
 * `writeReviewGraphCheckpoint` posted the object, so V8 structured-cloned the
 * whole graph into the worker heap and the worker stringified it again.
 *
 * Recurrences these tests prevent:
 *  - a request that carries the object again puts the clone back; a transfer
 *    list dropped from `postMessage` copies the bytes instead of moving them;
 *  - the serialization now runs on the dispatching thread, inside a debounce
 *    timer callback (persist) or the extraction loop (checkpoint). A throw
 *    there must be recorded and must not leave a request in flight, or the
 *    worker-exit handler later counts it as pending and kills the worker;
 *  - the string chunker the object path used split a surrogate pair that
 *    straddled a 256 KiB chunk boundary, so the stored body held U+FFFD;
 *  - the corpus proves the bytes written are the bytes the released code wrote.
 *
 * Fixture corpus: tests/fixtures/review-graph-persist/released-ca7e89066
 * (written by ca7e89066, the commit before this change).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reads the real sinks' rows: both mocks delegate to the real logger.
const latencyRows = vi.hoisted(
	() => [] as Array<{ phase?: string; metadata?: Record<string, unknown> }>,
);
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Parameters<typeof actual.logLatency>[0]) => {
			latencyRows.push(entry as (typeof latencyRows)[number]);
			actual.logLatency(entry);
		},
	};
});
const graphLog = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../clients/review-graph-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/review-graph-logger.js")
		>();
	return {
		...actual,
		logReviewGraph: (entry: Parameters<typeof actual.logReviewGraph>[0]) => {
			graphLog.push(entry as unknown as Record<string, unknown>);
			actual.logReviewGraph(entry);
		},
	};
});

import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersist,
	getCheckpointOffloadCountForTests,
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
	graphLog.length = 0;
	latencyRows.length = 0;
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
	const env = setupTestEnvironment("pi-lens-graph-transfer-");
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

function startCheckpoints(): void {
	process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES =
		CORPUS_CHECKPOINT_EVERY_FILES;
	process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS = "0";
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

interface Post {
	site: Site;
	isBytes: boolean;
	byteLength: number;
	transferListHoldsBody: boolean;
	detachedAfterPost: boolean;
}

function capturePosts(): Post[] {
	const posts: Post[] = [];
	const realPost = Worker.prototype.postMessage;
	vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
		this: Worker,
		message: { data?: unknown; stagePath?: string },
		transferList?: ArrayBuffer[],
	) {
		const data = message.data;
		const isBytes = data instanceof Uint8Array;
		const byteLength = isBytes ? data.byteLength : 0;
		const transferListHoldsBody =
			isBytes && (transferList ?? []).some((item) => item === data.buffer);
		realPost.call(this, message, transferList);
		posts.push({
			site: siteOf(message.stagePath ?? ""),
			isBytes,
			byteLength,
			transferListHoldsBody,
			detachedAfterPost: isBytes && data.byteLength === 0,
		});
	} as typeof Worker.prototype.postMessage);
	return posts;
}

const mask = (body: string, root: string): string =>
	body
		.replaceAll(root, "<root>")
		.replace(/"builtAt":"[^"]*"/g, '"builtAt":"<masked>"');

const fixture = (name: string): string =>
	fs.readFileSync(path.join(CORPUS, name), "utf-8");

/** Spins so a phase timer around the call reads at least `ms`. */
function spin(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {
		/* hold the thread */
	}
}

/** Makes `JSON.stringify` throw (or stall) for one payload shape only. */
function interceptStringify(
	matches: (value: object) => boolean,
	onMatch: () => void,
): void {
	const real = JSON.stringify;
	vi.spyOn(JSON, "stringify").mockImplementation(((
		value: unknown,
		...rest: unknown[]
	) => {
		if (typeof value === "object" && value !== null && matches(value)) {
			onMatch();
		}
		return (real as (...args: unknown[]) => string)(value, ...rest);
	}) as typeof JSON.stringify);
}
const isPersistPayload = (value: object): boolean =>
	"fileSignatures" in value && "nodes" in value && !("processedFiles" in value);
const isCheckpointPayload = (value: object): boolean =>
	"processedFiles" in value && "nodes" in value;

describe("review-graph worker persist transfers serialized bytes (#3913)", () => {
	it("moves the persist body to the worker instead of cloning the graph", async () => {
		const cwd = makeProject(CORPUS_FILES);
		const posts = capturePosts();
		const stages = captureStages();

		await buildOrUpdateGraph(cwd, [], new FactStore());
		await waitForReviewGraphPersistsForTests();

		expect(posts).toEqual([
			{
				site: "persist",
				isBytes: true,
				byteLength: Buffer.byteLength(stages[0].body),
				transferListHoldsBody: true,
				detachedAfterPost: true,
			},
		]);
	});

	it("moves the checkpoint body to the worker instead of cloning the graph", async () => {
		const cwd = makeProject(CORPUS_FILES);
		startCheckpoints();
		const posts = capturePosts();

		await buildOrUpdateGraph(cwd, [], new FactStore());
		await waitForReviewGraphPersistsForTests();

		const checkpointPosts = posts.filter((post) => post.site === "checkpoint");
		expect(checkpointPosts.length).toBeGreaterThanOrEqual(1);
		for (const post of checkpointPosts) {
			expect(post).toMatchObject({
				isBytes: true,
				transferListHoldsBody: true,
				detachedAfterPost: true,
			});
			expect(post.byteLength).toBeGreaterThan(0);
		}
	});

	it("records a serialize throw at the persist site and leaves no request in flight", async () => {
		const cwd = makeProject(CORPUS_FILES);
		const posts = capturePosts();
		interceptStringify(isPersistPayload, () => {
			throw new Error("persist-serialize-boom");
		});

		// A throw out of the build (debounce 0 runs the persist inline) or out of
		// the debounce timer would be host-fatal.
		await expect(
			buildOrUpdateGraph(cwd, [], new FactStore()),
		).resolves.toBeDefined();
		const waitStarted = performance.now();
		await waitForReviewGraphPersistsForTests();
		// An orphaned request would make the wait spin its whole 2 s.
		expect(performance.now() - waitStarted).toBeLessThan(1000);

		expect(posts).toEqual([]);
		expect(fs.existsSync(reviewGraphCachePath(cwd))).toBe(false);
		expect(
			graphLog.find((entry) => entry.phase === "persist_failed"),
		).toMatchObject({
			reason: "serialize_failed",
			error: "persist-serialize-boom",
		});

		// The key stays usable: the next build persists normally.
		vi.restoreAllMocks();
		fs.appendFileSync(path.join(cwd, "src/a.ts"), "export const more = 2;\n");
		clearReviewGraphWorkspaceCache(cwd);
		clearGraphCache();
		await buildOrUpdateGraph(cwd, [], new FactStore());
		await waitForReviewGraphPersistsForTests();
		expect(fs.existsSync(reviewGraphCachePath(cwd))).toBe(true);
	});

	it("records a serialize throw from the debounce timer without crashing the host", async () => {
		const cwd = makeProject(CORPUS_FILES);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "20";
		interceptStringify(isPersistPayload, () => {
			throw new Error("timer-serialize-boom");
		});

		await buildOrUpdateGraph(cwd, [], new FactStore());
		await vi.waitFor(() =>
			expect(
				graphLog.find((entry) => entry.phase === "persist_failed"),
			).toMatchObject({
				reason: "serialize_failed",
				error: "timer-serialize-boom",
			}),
		);
	});

	it("records a serialize throw at the checkpoint site and leaves no request in flight", async () => {
		const cwd = makeProject(CORPUS_FILES);
		startCheckpoints();
		interceptStringify(isCheckpointPayload, () => {
			throw new Error("checkpoint-serialize-boom");
		});

		const graph = await buildOrUpdateGraph(cwd, [], new FactStore());
		const waitStarted = performance.now();
		await waitForReviewGraphPersistsForTests();
		expect(performance.now() - waitStarted).toBeLessThan(1000);

		expect(graph.nodes.size).toBeGreaterThan(0);
		expect(getCheckpointOffloadCountForTests()).toBe(0);
		expect(
			graphLog.find((entry) => entry.phase === "checkpoint_write_failed"),
		).toMatchObject({
			reason: "serialize_failed",
			error: "checkpoint-serialize-boom",
		});
		// The authoritative persist is a separate site and still lands.
		expect(fs.existsSync(reviewGraphCachePath(cwd))).toBe(true);
	});

	it("reports the dispatcher's serialize time on the review_graph_persist row", async () => {
		const cwd = makeProject(CORPUS_FILES);
		const stages = captureStages();
		// The worker now receives bytes, so its own serialize time is about zero;
		// the row's `serializeMs` must still carry the stringify the main thread
		// paid. Stalling the main-thread stringify makes that visible exactly.
		interceptStringify(isPersistPayload, () => spin(25));

		await buildOrUpdateGraph(cwd, [], new FactStore());
		await waitForReviewGraphPersistsForTests();

		const row = latencyRows.find(
			(entry) => entry.phase === "review_graph_persist",
		);
		expect(row?.metadata).toMatchObject({
			offloaded: true,
			rawBytes: Buffer.byteLength(stages[0].body),
		});
		expect(row?.metadata?.serializeMs as number).toBeGreaterThanOrEqual(25);
		const logged = graphLog.find(
			(entry) => entry.phase === "persist_succeeded",
		);
		expect(logged?.serializeMs as number).toBeGreaterThanOrEqual(25);
	});
});

/**
 * The string chunker the worker used on the object path sliced at 256 KiB UTF-16
 * units, so a surrogate pair straddling a chunk boundary became two U+FFFD. The
 * bytes path cannot split one. The test builds a graph whose body puts a high
 * surrogate at index CHUNK - 1, then compares the worker's stored body to the
 * main-thread body of the same graph.
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
		startCheckpoints();
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
