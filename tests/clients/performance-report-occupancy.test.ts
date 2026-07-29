import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	collectLatencyPerformance,
	MAX_PERF_LOG_BYTES,
	MAX_PERF_PHASE_SAMPLES,
} from "../../clients/performance-report.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";
import { removeTempDirSync } from "./test-utils.js";

const MAX_SYNC_BLOCK_MS = 75;

let tempDir: string;
let logPath: string;

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-perf-occupancy-"));
	logPath = path.join(tempDir, "latency.log");
	const chunk = Array.from(
		{ length: 1000 },
		(_, index) =>
			`${JSON.stringify({
				type: "phase",
				phase: "occupancy-fixture",
				filePath: "fixture.ts",
				durationMs: ((index * 7919) % 10_000) + 1,
				pid: 7,
				ts: "2026-01-01T00:00:00.000Z",
			})}\n`,
	).join("");
	fs.writeFileSync(
		logPath,
		chunk.repeat(Math.ceil(MAX_PERF_LOG_BYTES / Buffer.byteLength(chunk))),
	);
}, 30_000);

afterAll(() => {
	removeTempDirSync(tempDir);
});

it("keeps /lens-perf log parsing below the event-loop occupancy budget", {
	retry: 2,
	timeout: 30_000,
}, async () => {
	let retainedSamples = 0;
	const maxBlock = await measureMaxSyncBlockMs(async () => {
		const report = await collectLatencyPerformance({
			logPath,
			processId: 7,
			sessionStartedAt: 0,
		});
		retainedSamples = report.logWindow.sampleCount;
	});

	expect(retainedSamples).toBe(MAX_PERF_PHASE_SAMPLES);
	expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
});
