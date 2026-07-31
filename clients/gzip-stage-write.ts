import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export interface GzipStageWriteMetrics {
	/** Uncompressed byte length of the serialized JSON. */
	rawBytes: number;
	/** On-disk size of the gzipped stage file. */
	gzBytes: number;
	serializeMs: number;
	writeMs: number;
}

/**
 * Shared worker-thread body-persist core (#958, single source of truth #883):
 * `JSON.stringify` → chunked `createGzip` pipeline → `<stagePath>.tmp-<pid>` →
 * atomic rename to `stagePath`, returning byte/timing metrics. Both
 * `clients/review-graph/persist-worker.ts` and
 * `clients/project-snapshot-persist-worker.ts` call this so the streamed-gzip
 * write lives in exactly one place; each worker's `parentPort` wiring owns its
 * own request/result envelope and maps a thrown error onto its own `error`
 * field. The chunked generator keeps the whole JSON string off a single giant
 * Buffer (the whole reason the write is on a worker thread — a naïve sync gzip
 * on the main save path regressed host memory by +656MB, per the #950 review).
 *
 * On failure the partial `.tmp` is removed and the error is rethrown for the
 * caller to record; the `stagePath` itself is only ever created by the atomic
 * rename, so a crash mid-write can never leave a torn stage file behind.
 */
export async function writeGzipStageFile(
	data: unknown,
	stagePath: string,
	testDelayMs?: number,
): Promise<GzipStageWriteMetrics> {
	const tmpPath = `${stagePath}.tmp-${process.pid}`;
	try {
		if (testDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, testDelayMs));
		}
		const serializeStarted = performance.now();
		const json = JSON.stringify(data);
		const serializeMs = performance.now() - serializeStarted;
		const rawBytes = Buffer.byteLength(json);

		const writeStarted = performance.now();
		await fs.promises.mkdir(path.dirname(stagePath), { recursive: true });
		const chunks = function* () {
			const chunkChars = 256 * 1024;
			for (let offset = 0; offset < json.length; offset += chunkChars) {
				yield json.slice(offset, offset + chunkChars);
			}
		};
		await pipeline(
			Readable.from(chunks()),
			createGzip(),
			fs.createWriteStream(tmpPath),
		);
		await fs.promises.rename(tmpPath, stagePath);
		const writeMs = performance.now() - writeStarted;
		const gzBytes = (await fs.promises.stat(stagePath)).size;
		return { rawBytes, gzBytes, serializeMs, writeMs };
	} catch (err) {
		await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
		throw err;
	}
}
