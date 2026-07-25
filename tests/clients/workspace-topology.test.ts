import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as latencyLogger from "../../clients/latency-logger.js";

// `vi.spyOn(fs, "readdirSync")` cannot redefine a node: built-in's ESM
// namespace export directly, so wrap it via vi.mock instead — keeps the
// real implementation (via importOriginal) but lets tests assert call
// counts to verify the "one readdir pass per directory visit" invariant.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});
import {
	findGoverningTsconfigDir,
	findNearestDirWithMarker,
	findPiLensConfigMarkerInDir,
	getDirectoryMarkers,
	getWorkspaceManifestMarkers,
	resetWorkspaceTopology,
} from "../../clients/workspace-topology.js";
import { setupTestEnvironment } from "./test-utils.js";

let root: string;
let cleanup: () => void;

beforeEach(() => {
	const env = setupTestEnvironment("pi-lens-workspace-topology-");
	root = env.tmpDir;
	cleanup = env.cleanup;
	resetWorkspaceTopology();
	vi.mocked(fs.readdirSync).mockClear();
});

afterEach(() => {
	resetWorkspaceTopology();
	cleanup();
	vi.restoreAllMocks();
});

function write(rel: string, content = "{}"): string {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
	return full;
}

describe("getDirectoryMarkers — marker index correctness", () => {
	it("collects all markers in one directory visit, incl both .pi-lens.json basenames", () => {
		write(".pi-lens.json");
		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBe(path.join(root, ".pi-lens.json"));
	});

	it("falls back to the no-dot pi-lens.json basename when .pi-lens.json is absent", () => {
		write("pi-lens.json");
		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBe(path.join(root, "pi-lens.json"));
	});

	it("prefers .pi-lens.json over pi-lens.json when both exist", () => {
		write(".pi-lens.json");
		write("pi-lens.json");
		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBe(path.join(root, ".pi-lens.json"));
	});

	it("collects tsconfig.json and workspace-manifest markers alongside the pi-lens config", () => {
		write(".pi-lens.json");
		write("tsconfig.json");
		write("package.json", '{"name":"demo"}');
		write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
		write("Cargo.toml", "[workspace]\n");
		write("go.work", "go 1.21\n");
		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBe(path.join(root, ".pi-lens.json"));
		expect(markers.tsconfigPath).toBe(path.join(root, "tsconfig.json"));
		expect(markers.packageJsonPath).toBe(path.join(root, "package.json"));
		expect(markers.pnpmWorkspaceYamlPath).toBe(
			path.join(root, "pnpm-workspace.yaml"),
		);
		expect(markers.cargoTomlPath).toBe(path.join(root, "Cargo.toml"));
		expect(markers.goWorkPath).toBe(path.join(root, "go.work"));
	});

	it("returns undefined markers for an empty directory", () => {
		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBeUndefined();
		expect(markers.tsconfigPath).toBeUndefined();
		expect(markers.packageJsonPath).toBeUndefined();
		expect(markers.pnpmWorkspaceYamlPath).toBeUndefined();
		expect(markers.cargoTomlPath).toBeUndefined();
		expect(markers.goWorkPath).toBeUndefined();
	});

	it("tolerates a directory that does not exist", () => {
		const markers = getDirectoryMarkers(path.join(root, "does", "not", "exist"));
		expect(markers.piLensConfigPath).toBeUndefined();
		expect(markers.dirMtimeMs).toBe(-1);
	});
});

describe("getDirectoryMarkers — single readdir pass per directory visit", () => {
	it("collects ALL markers from one readdirSync call, not one per marker", () => {
		write(".pi-lens.json");
		write("tsconfig.json");
		write("package.json", "{}");

		const markers = getDirectoryMarkers(root);
		expect(markers.piLensConfigPath).toBeDefined();
		expect(markers.tsconfigPath).toBeDefined();
		expect(markers.packageJsonPath).toBeDefined();
		// Exactly one directory listing for the visit that populated all three.
		expect(fs.readdirSync).toHaveBeenCalledTimes(1);
	});

	it("does not re-list the directory on a cache hit (dir mtime unchanged)", () => {
		write("tsconfig.json");
		getDirectoryMarkers(root); // populate cache
		vi.mocked(fs.readdirSync).mockClear();
		getDirectoryMarkers(root);
		getDirectoryMarkers(root);
		expect(fs.readdirSync).not.toHaveBeenCalled();
	});
});

describe("getDirectoryMarkers — mtime invalidation", () => {
	it("re-scans when a file is added to the directory (dir mtime bumps)", async () => {
		const before = getDirectoryMarkers(root);
		expect(before.tsconfigPath).toBeUndefined();

		// Sleep so the directory's mtime measurably advances across filesystems.
		await new Promise((r) => setTimeout(r, 20));
		write("tsconfig.json");

		const after = getDirectoryMarkers(root);
		expect(after.tsconfigPath).toBe(path.join(root, "tsconfig.json"));
	});

	it("findPiLensConfigMarkerInDir picks up a content-only rewrite via a fresh file stat", async () => {
		const configPath = write(".pi-lens.json", '{"ignore":["a"]}');
		const marker1 = findPiLensConfigMarkerInDir(root);
		expect(marker1?.mtimeMs).toBeDefined();

		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(configPath, '{"ignore":["a","b"]}');

		const marker2 = findPiLensConfigMarkerInDir(root);
		expect(marker2?.mtimeMs).toBeGreaterThan(marker1!.mtimeMs);
	});
});

describe("findNearestDirWithMarker / findGoverningTsconfigDir", () => {
	it("walks up to the nearest ancestor carrying the marker", () => {
		write("tsconfig.json");
		const sub = path.join(root, "src", "lib");
		fs.mkdirSync(sub, { recursive: true });
		expect(findGoverningTsconfigDir(sub, "/nonexistent-home-zzz")).toBe(root);
	});

	it("returns undefined when no ancestor carries the marker", () => {
		const sub = path.join(root, "src", "lib");
		fs.mkdirSync(sub, { recursive: true });
		expect(findGoverningTsconfigDir(sub, "/nonexistent-home-zzz")).toBeUndefined();
	});

	it("never resolves a marker at or above the home-dir ceiling", () => {
		write("tsconfig.json");
		const project = path.join(root, "project", "src");
		fs.mkdirSync(project, { recursive: true });
		// homeDir === root: the marker lives exactly at the ceiling directory,
		// so the walk must refuse it (mirrors the #253 isAtOrAboveHomeDir rule).
		expect(findGoverningTsconfigDir(project, root)).toBeUndefined();
	});
});

describe("findNearestDirWithMarker — walk cap + latency logging", () => {
	it("caps the climb and logs a phase entry instead of truncating silently", () => {
		const logSpy = vi
			.spyOn(latencyLogger, "logLatency")
			.mockImplementation(() => {});

		// Synthetic (non-existent) deep path — walkUpDirs only does string
		// manipulation via path.dirname, so no real directories are needed.
		const segments = Array.from({ length: 100 }, (_, i) => `level${i}`);
		const deepStart = path.join(
			path.parse(root).root,
			"synthetic-workspace-topology-cap-test",
			...segments,
		);
		// A homeDir far outside the synthetic tree so isAtOrAboveHomeDir never
		// short-circuits the walk before the depth cap does.
		const result = findNearestDirWithMarker(
			deepStart,
			"tsconfigPath",
			path.join(path.parse(root).root, "definitely-not-a-real-home-zzz"),
		);

		expect(result).toBeUndefined();
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "phase",
				phase: "workspace-topology-walk-cap",
			}),
		);
	});
});

describe("getWorkspaceManifestMarkers", () => {
	it("reports presence of each workspace manifest marker", () => {
		write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
		const markers = getWorkspaceManifestMarkers(root);
		expect(markers.hasPnpmWorkspaceYaml).toBe(true);
		expect(markers.hasGoWork).toBe(false);
		expect(markers.hasCargoToml).toBe(false);
		expect(markers.hasPackageJson).toBe(false);
	});
});

describe("resetWorkspaceTopology", () => {
	it("clears the per-directory marker cache so the next access re-scans", () => {
		write("tsconfig.json");
		getDirectoryMarkers(root); // populate cache

		vi.mocked(fs.readdirSync).mockClear();
		getDirectoryMarkers(root);
		expect(fs.readdirSync).not.toHaveBeenCalled();

		resetWorkspaceTopology();

		vi.mocked(fs.readdirSync).mockClear();
		getDirectoryMarkers(root);
		expect(fs.readdirSync).toHaveBeenCalledTimes(1);
	});

	it("clears the upward-walk cache so a reset forces a fresh climb", () => {
		write("tsconfig.json");
		const sub = path.join(root, "src");
		fs.mkdirSync(sub, { recursive: true });
		expect(findGoverningTsconfigDir(sub, "/nonexistent-home-zzz")).toBe(root);

		// Cache hit: neither the walk cache nor the per-dir marker cache is
		// touched, so no directory gets re-listed.
		vi.mocked(fs.readdirSync).mockClear();
		findGoverningTsconfigDir(sub, "/nonexistent-home-zzz");
		expect(fs.readdirSync).not.toHaveBeenCalled();

		resetWorkspaceTopology();

		// Post-reset: both caches are empty, so the climb re-lists every
		// directory it visits on the way to (and including) `root`.
		vi.mocked(fs.readdirSync).mockClear();
		expect(findGoverningTsconfigDir(sub, "/nonexistent-home-zzz")).toBe(root);
		expect(fs.readdirSync).toHaveBeenCalled();
	});
});
