import { parentPort } from "node:worker_threads";
import { writeGzipStageFile } from "./gzip-stage-write.js";

/**
 * Worker-thread persist for the project snapshot BODY (#958 item 2). The parent
 * (project-snapshot.ts) posts the (large) snapshot object plus a monotonic
 * `generation` and a per-generation `stagePath`; the streamed stringify+gzip
 * runs ENTIRELY off the main thread via the shared `writeGzipStageFile` core
 * (clients/gzip-stage-write.ts, also used by the review-graph persist worker),
 * then this posts back byte/timing metrics. The parent does the
 * generation-gated promotion (rename stage → canonical) so a slow write for an
 * older generation can never clobber a newer snapshot already on disk.
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
	throw new Error("project-snapshot persist worker requires a parent port");
}
parentPort.on("message", (request: ProjectSnapshotPersistWorkerRequest) => {
	void persist(request);
});
