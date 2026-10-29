/**
 * #4937: `drainRegisteredBackgroundWritesForTests` joins the deferred writers
 * of EVERY evaluation of a registering module, not only the one the test
 * imported.
 *
 * Recurrence this prevents: master run 40967488612 (shard 2/5) leaked
 * `pi-lens-pi-session-yB7mpc` from `tests/lens-toggle-command.test.ts`. The
 * tier-2 harness loads the built extension through pi's own jiti loader
 * (`moduleCache: false`), so the extension runs its OWN copy of
 * `clients/project-snapshot.ts`, and that copy's in-flight worker write landed
 * under `<fixture>/data` AFTER the file's drain and removal, re-creating the
 * root. The drain waited on the test's copy only, whose queue was empty. The
 * installer's debounced probe-cache flush has the same shape (a 300 ms timer
 * in the loaded copy).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainRegisteredBackgroundWritesForTests } from "../../clients/background-write-drains.js";
import {
	resetProjectSnapshotPersistWorkerForTests,
	terminateProjectSnapshotPersistWorkerForTests,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import type { ProjectSnapshot } from "../../clients/project-snapshot.js";
import { setupTestEnvironment } from "./test-utils.js";

const CORPUS = path.join(
	import.meta.dirname,
	"../fixtures/snapshot-persist/released-4.3.0",
);

const PINNED_KEYS = ["PI_LENS_HOME", "PILENS_DATA_DIR"] as const;
const savedEnv: Record<string, string | undefined> = {};

function pinEnv(home: string, data: string): void {
	for (const key of PINNED_KEYS) savedEnv[key] = process.env[key];
	process.env.PI_LENS_HOME = home;
	process.env.PILENS_DATA_DIR = data;
}

afterEach(async () => {
	for (const key of PINNED_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	delete process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
	await waitForProjectSnapshotPersistsForTests();
	await terminateProjectSnapshotPersistWorkerForTests();
	resetProjectSnapshotPersistWorkerForTests();
});

describe("background write drains across module copies (#4937)", () => {
	it("joins a snapshot persist that another copy of the module has in flight", async () => {
		const env = setupTestEnvironment("bwd-snapshot-");
		try {
			pinEnv(path.join(env.tmpDir, "home"), path.join(env.tmpDir, "data"));
			// A second evaluation of the module: its queue is not the one the
			// statically imported copy above reads.
			vi.resetModules();
			const other = await import("../../clients/project-snapshot.js");
			expect(other.waitForProjectSnapshotPersistsForTests).not.toBe(
				waitForProjectSnapshotPersistsForTests,
			);
			const snapshot = JSON.parse(
				fs.readFileSync(path.join(CORPUS, "snapshot.json"), "utf-8"),
			) as ProjectSnapshot;
			const cwd = path.join(env.tmpDir, "project");
			// The worker holds the write long enough for the assertion below to
			// see it in flight; the delay is the module's own test seam.
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "400";
			other.saveProjectSnapshot(cwd, snapshot);
			expect(other.getProjectSnapshotPersistStateForTests(cwd).active).toBe(
				true,
			);

			await drainRegisteredBackgroundWritesForTests();

			expect(other.getProjectSnapshotPersistStateForTests(cwd).active).toBe(
				false,
			);
			expect(fs.existsSync(other.getProjectSnapshotPath(cwd))).toBe(true);
			await other.terminateProjectSnapshotPersistWorkerForTests();
		} finally {
			env.cleanup();
		}
	}, 30_000);

	it("joins a probe-cache flush that another copy of the installer has pending", async () => {
		const env = setupTestEnvironment("bwd-probe-cache-");
		try {
			const home = path.join(env.tmpDir, "home");
			fs.mkdirSync(home, { recursive: true });
			pinEnv(home, path.join(env.tmpDir, "data"));
			const tool = path.join(env.tmpDir, "tool.sh");
			fs.writeFileSync(tool, "#!/bin/sh\n");
			// The cache path is fixed when the module loads, so the second copy
			// is evaluated under the pinned home.
			vi.resetModules();
			const other = await import("../../clients/installer/index.js");
			await other.updateProbeCache("probe-tool", tool);
			const cacheFile = path.join(home, "probe-cache.json");
			// The debounced timer (300 ms) has not fired: the write is deferred.
			expect(fs.existsSync(cacheFile)).toBe(false);

			await drainRegisteredBackgroundWritesForTests();

			expect(
				Object.keys(JSON.parse(fs.readFileSync(cacheFile, "utf-8"))),
			).toEqual(["probe-tool"]);
			other.resetProbeCacheStateForTesting();
		} finally {
			env.cleanup();
		}
	});
});
