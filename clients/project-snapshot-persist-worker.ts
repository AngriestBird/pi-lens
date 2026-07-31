import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parentPort } from "node:worker_threads";
import { createGzip } from "node:zlib";

/**
 * Worker-thread persist for the project snapshot BODY (#958 item 2). Mirrors
 * `clients/review-graph/persist-worker.ts`: the parent posts the (large)
 * snapshot object plus a monotonic `generation` and a per-generation
 * `stagePath`; the worker does the `JSON.stringify` → chunked `createGzip`
 * pipeline → tmp file → atomic rename ENTIRELY off the main thread, then posts
 * back byte/timing metrics. The parent (project-snapshot.ts) does the
 * generation-gated promotion (rename stage → canonical) so a slow write for an
 * older generation can never clobber a newer snapshot already on disk.
 *
 * The stringify+gzip is deliberately NOT run synchronously on the save path:
 * the #950 review measured a naïve sync gzip regress host memory by +656MB, so
 * the whole point of this worker is to keep that cost off the event loop.
 */
export interface ProjectSnapshotPersistWorkerRequest {
	id: number;
	generation: number;
	stagePath: string;
	data: unknown;
	testDelayMs?: number;
}

export interface ProjectSnapshotPersistWorkerResult {
	id: number;
	generation: number;
	stagePath: string;
	rawBytes?: number;
	gzBytes?: number;
	serializeMs?: number;
	writeMs?: number;
	error?: string;
}

async function persist(
	request: ProjectSnapshotPersistWorkerRequest,
): Promise<void> {
	const result: ProjectSnapshotPersistWorkerResult = {
		id: request.id,
		generation: request.generation,
		stagePath: request.stagePath,
	};
	const tmpPath = `${request.stagePath}.tmp-${process.pid}`;
	try {
		if (request.testDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, request.testDelayMs));
		}
		const serializeStarted = performance.now();
		const json = JSON.stringify(request.data);
		result.serializeMs = performance.now() - serializeStarted;
		result.rawBytes = Buffer.byteLength(json);

		const writeStarted = performance.now();
		await fs.promises.mkdir(path.dirname(request.stagePath), {
			recursive: true,
		});
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
		await fs.promises.rename(tmpPath, request.stagePath);
		result.writeMs = performance.now() - writeStarted;
		result.gzBytes = (await fs.promises.stat(request.stagePath)).size;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
	}
	parentPort?.postMessage(result);
}

if (!parentPort) {
	throw new Error("project-snapshot persist worker requires a parent port");
}
parentPort.on("message", (request: ProjectSnapshotPersistWorkerRequest) => {
	void persist(request);
});
