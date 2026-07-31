import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

const readJsonCacheSpy = vi.hoisted(() => vi.fn());
vi.mock("../../clients/json-cache-read.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/json-cache-read.js")>();
	readJsonCacheSpy.mockImplementation(actual.readJsonCache);
	return { ...actual, readJsonCache: readJsonCacheSpy };
});

import {
	PROJECT_SNAPSHOT_VERSION,
	_resetProjectSnapshotParseCacheForTests,
	buildProjectSnapshotFromRuntime,
	getProjectSnapshotMetaPath,
	getProjectSnapshotPath,
	hydrateRuntimeFromProjectSnapshot,
	isProjectSnapshotFresh,
	isProjectSnapshotMetaStale,
	loadProjectSnapshot,
	readProjectSnapshotMeta,
	saveProjectSnapshot,
	saveRuntimeProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { buildWordIndex, searchWordIndex } from "../../clients/word-index.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

function withProjectDataDir<T>(fn: (cwd: string) => T): T {
	const env = setupTestEnvironment("project-snapshot-");
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	try {
		return fn(path.join(env.tmpDir, "project"));
	} finally {
		if (previousDataDir === undefined) {
			delete process.env.PILENS_DATA_DIR;
		} else {
			process.env.PILENS_DATA_DIR = previousDataDir;
		}
		env.cleanup();
	}
}

describe("project snapshot", () => {
	it("builds, saves, and loads a runtime snapshot", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			runtime.cachedExports.set("makeThing", path.join(cwd, "src", "a.ts"));
			runtime.projectRulesScan = {
				hasCustomRules: true,
				rules: [
					{
						source: "root",
						name: "AGENTS.md",
						filePath: path.join(cwd, "AGENTS.md"),
						relativePath: "AGENTS.md",
					},
				],
			};

			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, snapshot);

			expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(true);
			expect(fs.existsSync(getProjectSnapshotMetaPath(cwd))).toBe(true);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded).toMatchObject({
				version: PROJECT_SNAPSHOT_VERSION,
				seq: 7,
				cachedExports: [["makeThing", path.join(cwd, "src", "a.ts")]],
			});
			expect(isProjectSnapshotFresh(loaded, 7)).toBe(true);
		}));

	it("persists the word index and hydrates a searchable copy", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(5);
			runtime.wordIndex = buildWordIndex([
				{
					path: path.join(cwd, "src", "auth.ts"),
					content: "export function authenticateUser() {}",
				},
			]);

			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime }),
			);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.wordIndex).toBeDefined();

			// Hydrate a fresh runtime → its word index must be searchable.
			const target = new RuntimeCoordinator();
			hydrateRuntimeFromProjectSnapshot(target, loaded!);
			expect(target.wordIndex).not.toBeNull();
			const results = searchWordIndex(target.wordIndex!, "authenticate user");
			expect(results[0]?.file).toBe(path.join(cwd, "src", "auth.ts"));
		}));

	it("preserves a previously-persisted word index when the runtime has none", () =>
		withProjectDataDir((cwd) => {
			const withIndex = new RuntimeCoordinator();
			withIndex.seedProjectSequence(2);
			withIndex.wordIndex = buildWordIndex([
				{ path: path.join(cwd, "a.ts"), content: "function keepMe() {}" },
			]);
			saveRuntimeProjectSnapshot({ cwd, runtime: withIndex });

			// A later save from a runtime whose word-index task hasn't finished
			// must not clobber the persisted index.
			const without = new RuntimeCoordinator();
			without.seedProjectSequence(2);
			saveRuntimeProjectSnapshot({ cwd, runtime: without });

			expect(loadProjectSnapshot(cwd)?.wordIndex).toBeDefined();
		}));

	it("does NOT launder a stale word index into looking fresh across a seq bump (#348 seq-laundering guard)", () =>
		withProjectDataDir((cwd) => {
			// Persist a word index at seq=2.
			const withIndex = new RuntimeCoordinator();
			withIndex.seedProjectSequence(2);
			withIndex.wordIndex = buildWordIndex([
				{ path: path.join(cwd, "a.ts"), content: "function staleOnly() {}" },
			]);
			saveRuntimeProjectSnapshot({ cwd, runtime: withIndex });
			expect(loadProjectSnapshot(cwd)?.seq).toBe(2);
			expect(loadProjectSnapshot(cwd)?.wordIndex).toBeDefined();

			// A later save at a NEW seq (project moved on), from a runtime whose
			// word-index task hasn't (re)built yet. Without the guard, this save
			// would re-stamp the seq=2 index as seq=3 — making a stale index look
			// fresh to isProjectSnapshotFresh's seq check, even though it predates
			// the seq bump and its rebuild hasn't happened. The guard (existing.seq
			// === snapshot.seq) must instead DROP the stale index here.
			const without = new RuntimeCoordinator();
			without.seedProjectSequence(3);
			saveRuntimeProjectSnapshot({ cwd, runtime: without });

			const laundered = loadProjectSnapshot(cwd);
			expect(laundered?.seq).toBe(3);
			expect(laundered?.wordIndex).toBeUndefined();
		}));

	it("rejects wrong-version, stale, and future snapshots", () =>
		withProjectDataDir((cwd) => {
			const badPath = getProjectSnapshotPath(cwd);
			fs.mkdirSync(path.dirname(badPath), { recursive: true });
			fs.writeFileSync(
				badPath,
				JSON.stringify({
					version: 999,
					projectRoot: cwd,
					generatedAt: new Date().toISOString(),
					seq: 1,
					cachedExports: [],
				}),
			);
			expect(loadProjectSnapshot(cwd)).toBeNull();

			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(3);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			expect(isProjectSnapshotFresh(snapshot, 2)).toBe(false);
			expect(isProjectSnapshotFresh(snapshot, 4)).toBe(false);
			expect(isProjectSnapshotFresh(snapshot, 3)).toBe(true);
		}));

	it("persists startup scan context and language profile", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(9);
			const snapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime,
				startupScan: {
					cwd,
					scanRoot: cwd,
					projectRoot: cwd,
					canWarmCaches: true,
					sourceFileCount: 2,
				},
				languageProfile: {
					present: { jsts: true } as never,
					configured: { jsts: true },
					counts: { jsts: 2 },
					detectedKinds: ["jsts"],
				},
			});
			saveProjectSnapshot(cwd, snapshot);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.startupScan).toMatchObject({
				canWarmCaches: true,
				sourceFileCount: 2,
			});
			expect(loaded?.languageProfile?.detectedKinds).toEqual(["jsts"]);
		}));

	it("roundtrips project conventions through build + save + load", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(11);
			const snapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime,
				conventions: {
					frameworks: [
						{
							id: "react",
							confidence: "high",
							signals: [
								"package.json:dependencies.react",
								"package.json:dependencies.react-dom",
							],
						},
						{
							id: "vite",
							confidence: "high",
							signals: ["vite.config.ts"],
						},
					],
					testRunners: ["vitest"],
					buildTools: ["vite"],
					agentDocs: [{ filePath: "AGENTS.md", lineCount: 42 }],
				},
			});
			saveProjectSnapshot(cwd, snapshot);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.conventions?.frameworks.map((f) => f.id).sort()).toEqual([
				"react",
				"vite",
			]);
			expect(loaded?.conventions?.testRunners).toEqual(["vitest"]);
			expect(loaded?.conventions?.buildTools).toEqual(["vite"]);
			expect(loaded?.conventions?.agentDocs).toEqual([
				{ filePath: "AGENTS.md", lineCount: 42 },
			]);
		}));

	it("auto-detects conventions inside saveRuntimeProjectSnapshot when none are passed", () =>
		withProjectDataDir((cwd) => {
			fs.mkdirSync(cwd, { recursive: true });
			createTempFile(
				cwd,
				"package.json",
				JSON.stringify({
					dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
					devDependencies: { vite: "^5.0.0", vitest: "^1.0.0" },
				}),
			);
			createTempFile(cwd, "vite.config.ts", "export default {};\n");

			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(5);
			saveRuntimeProjectSnapshot({ cwd, runtime });

			const loaded = loadProjectSnapshot(cwd);
			const ids = loaded?.conventions?.frameworks.map((f) => f.id).sort();
			expect(ids).toEqual(["react", "vite", "vitest"]);
			expect(loaded?.conventions?.buildTools).toEqual(["vite"]);
		}));

	it("preserves existing conventions across a snapshot rewrite that does not supply them", () =>
		withProjectDataDir((cwd) => {
			fs.mkdirSync(cwd, { recursive: true });
			// First write — explicit conventions object.
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(2);
			const first = buildProjectSnapshotFromRuntime({
				cwd,
				runtime,
				conventions: {
					frameworks: [
						{ id: "next", confidence: "high", signals: ["next.config.js"] },
					],
					testRunners: [],
					buildTools: ["next"],
					agentDocs: [],
				},
			});
			saveProjectSnapshot(cwd, first);

			// Second write via saveRuntimeProjectSnapshot WITHOUT any package.json
			// nor a conventions arg — should inherit the previously-saved value
			// rather than overwriting it with the empty auto-detect result.
			saveRuntimeProjectSnapshot({ cwd, runtime });

			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.conventions?.frameworks.map((f) => f.id)).toEqual(["next"]);
		}));

	it("hydrates cached exports and rules into a new runtime", () =>
		withProjectDataDir((cwd) => {
			const source = new RuntimeCoordinator();
			source.seedProjectSequence(1);
			source.cachedExports.set("fromSnapshot", path.join(cwd, "src", "a.ts"));
			source.projectRulesScan = { hasCustomRules: true, rules: [] };
			const snapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime: source,
			});

			const target = new RuntimeCoordinator();
			target.cachedExports.set("stale", path.join(cwd, "src", "old.ts"));
			hydrateRuntimeFromProjectSnapshot(target, snapshot);

			expect([...target.cachedExports.entries()]).toEqual([
				["fromSnapshot", path.join(cwd, "src", "a.ts")],
			]);
			expect(target.projectRulesScan.hasCustomRules).toBe(true);
		}));

	it("meta sidecar round-trips and drives the staleness gate (#947)", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			saveProjectSnapshot(cwd, buildProjectSnapshotFromRuntime({ cwd, runtime }));

			const meta = readProjectSnapshotMeta(cwd);
			expect(meta).toMatchObject({
				version: PROJECT_SNAPSHOT_VERSION,
				seq: 7,
			});
			expect(typeof meta?.timestamp).toBe("string");
			expect(isProjectSnapshotMetaStale(meta!, 7)).toBe(false);
			// seq mismatch → stale; version mismatch → stale (the exact fields
			// isProjectSnapshotFresh checks on the parsed body).
			expect(isProjectSnapshotMetaStale(meta!, 8)).toBe(true);
			expect(
				isProjectSnapshotMetaStale(
					{ ...meta!, version: PROJECT_SNAPSHOT_VERSION + 1 },
					7,
				),
			).toBe(true);
		}));

	it("meta sidecar reader fails open: missing / corrupt / wrong-shaped meta → null (#947)", () =>
		withProjectDataDir((cwd) => {
			// Missing entirely.
			expect(readProjectSnapshotMeta(cwd)).toBeNull();

			// Corrupt JSON.
			const metaPath = getProjectSnapshotMetaPath(cwd);
			fs.mkdirSync(path.dirname(metaPath), { recursive: true });
			fs.writeFileSync(metaPath, "{ not json");
			expect(readProjectSnapshotMeta(cwd)).toBeNull();

			// Wrong shape (missing seq).
			fs.writeFileSync(metaPath, JSON.stringify({ version: 2 }));
			expect(readProjectSnapshotMeta(cwd)).toBeNull();
		}));

	it("serializes the snapshot body compactly, and still reads legacy pretty-printed bodies (#947)", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, snapshot);

			// Compact: no pretty-print newlines; exactly the minimal JSON form.
			const raw = fs.readFileSync(getProjectSnapshotPath(cwd), "utf-8");
			expect(raw).not.toContain("\n");
			expect(raw).toBe(JSON.stringify(JSON.parse(raw)));

			// Legacy pretty-printed bodies (written by older pi-lens versions)
			// must still parse.
			_resetProjectSnapshotParseCacheForTests();
			fs.writeFileSync(
				getProjectSnapshotPath(cwd),
				JSON.stringify(snapshot, null, 2),
			);
			const bumped = new Date(Date.now() + 5000);
			fs.utimesSync(getProjectSnapshotPath(cwd), bumped, bumped);
			expect(loadProjectSnapshot(cwd)?.seq).toBe(7);
		}));

	it("caches the parsed body per (cwd, mtime): save primes the cache, loads hit it, external writes invalidate (#947)", () =>
		withProjectDataDir((cwd) => {
			_resetProjectSnapshotParseCacheForTests();
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			runtime.cachedExports.set("makeThing", path.join(cwd, "src", "a.ts"));
			saveProjectSnapshot(cwd, buildProjectSnapshotFromRuntime({ cwd, runtime }));
			readJsonCacheSpy.mockClear();

			// Hit: a load right after our own save (the saveRuntimeProjectSnapshot
			// merge-read pattern) must NOT re-read/re-parse the file.
			const first = loadProjectSnapshot(cwd);
			expect(first?.seq).toBe(7);
			expect(readJsonCacheSpy).not.toHaveBeenCalled();

			// A repeat load serves the same parsed object.
			expect(loadProjectSnapshot(cwd)).toBe(first);
			expect(readJsonCacheSpy).not.toHaveBeenCalled();

			// An external write (different mtime) invalidates → re-parse.
			const other = new RuntimeCoordinator();
			other.seedProjectSequence(9);
			const snapshotPath = getProjectSnapshotPath(cwd);
			fs.writeFileSync(
				snapshotPath,
				JSON.stringify(buildProjectSnapshotFromRuntime({ cwd, runtime: other })),
			);
			const bumped = new Date(Date.now() + 5000);
			fs.utimesSync(snapshotPath, bumped, bumped);
			const third = loadProjectSnapshot(cwd);
			expect(readJsonCacheSpy).toHaveBeenCalled();
			expect(third?.seq).toBe(9);

			// Deleting the file invalidates and fails open to null.
			fs.unlinkSync(snapshotPath);
			expect(loadProjectSnapshot(cwd)).toBeNull();
		}));
});
