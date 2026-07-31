import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parentPort } from "node:worker_threads";
import { createGzip } from "node:zlib";

export interface ReviewGraphPersistWorkerRequest {
	id: number;
	cwd: string;
	generation: number;
	stagePath: string;
	data: unknown;
	elements: number;
	testDelayMs?: number;
}

export interface ReviewGraphPersistWorkerResult {
	id: number;
	cwd: string;
	generation: number;
	stagePath: string;
	elements: number;
	rawBytes?: number;
	gzBytes?: number;
	serializeMs?: number;
	writeMs?: number;
	error?: string;
}

async function persist(request: ReviewGraphPersistWorkerRequest): Promise<void> {
	const result: ReviewGraphPersistWorkerResult = {
		id: request.id,
		cwd: request.cwd,
		generation: request.generation,
		stagePath: request.stagePath,
		elements: request.elements,
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
		await fs.promises.mkdir(path.dirname(request.stagePath), { recursive: true });
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
	throw new Error("review-graph persist worker requires a parent port");
}
parentPort.on("message", (request: ReviewGraphPersistWorkerRequest) => {
	void persist(request);
});
