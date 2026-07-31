import { parentPort } from "node:worker_threads";
import { writeGzipStageFile } from "../gzip-stage-write.js";

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
	// Shared streamed-gzip stage write (clients/gzip-stage-write.ts) — see there
	// for why the gzip runs off the main thread.
	try {
		const metrics = await writeGzipStageFile(
			request.data,
			request.stagePath,
			request.testDelayMs,
		);
		result.rawBytes = metrics.rawBytes;
		result.gzBytes = metrics.gzBytes;
		result.serializeMs = metrics.serializeMs;
		result.writeMs = metrics.writeMs;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
	}
	parentPort?.postMessage(result);
}

if (!parentPort) {
	throw new Error("review-graph persist worker requires a parent port");
}
parentPort.on("message", (request: ReviewGraphPersistWorkerRequest) => {
	void persist(request);
});
