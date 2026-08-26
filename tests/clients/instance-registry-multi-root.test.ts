/**
 * #2130: the host registry entry holds a SET of roots, not one clobbered
 * scalar.
 *
 * The defect: `registerInstance` overwrote `projectRoot` on every call, so a
 * host whose subagent started a temp worktree advertised the TEMP DIR as its
 * project root. `selectLivePeerInstances` — the single predicate behind warm
 * attach (#2007) and the shared-checkout guard (#2107) — then compared against
 * that one clobbered value and could not see a peer under any other root.
 *
 * `getGlobalPiLensDir` is mocked to a per-test temp dir, so nothing here
 * touches the real `~/.pi-lens/instances.json`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

let dir: string;

vi.mock("../../clients/file-utils.js", () => ({
	getGlobalPiLensDir: () => dir,
}));

describe("instance-registry multi-root (#2130)", () => {
	let realRoot: string;
	let tempRoot: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-instreg-mr-"));
		// Real directories: `normalizeFilePath` canonicalizes an EXISTING path
		// via realpath, so comparing against a made-up path would compare two
		// differently-derived spellings and prove nothing.
		realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-root-real-"));
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-root-temp-"));
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		removeTempDirSync(dir);
		removeTempDirSync(realRoot);
		removeTempDirSync(tempRoot);
	});

	function readEntry(): {
		projectRoot: string;
		projectRoots?: string[];
	} {
		const raw = fs.readFileSync(path.join(dir, "instances.json"), "utf-8");
		return JSON.parse(raw).instances[0];
	}

	it("a second root is ADDED, not substituted for the first", async () => {
		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance(realRoot);
		await registerInstance(tempRoot);

		const entry = readEntry();
		expect(entry.projectRoots).toHaveLength(2);
		expect(entry.projectRoots?.[0]).toContain(path.basename(realRoot));
		expect(entry.projectRoots?.[1]).toContain(path.basename(tempRoot));
	});

	it("the primary projectRoot is pinned and never clobbered", async () => {
		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance(realRoot);
		await registerInstance(tempRoot);
		// This is the exact live symptom: the host advertised a temp dir.
		expect(readEntry().projectRoot).toContain(path.basename(realRoot));
		expect(readEntry().projectRoot).not.toContain(path.basename(tempRoot));
	});

	it("re-registering the same root does not duplicate it", async () => {
		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance(realRoot);
		await registerInstance(realRoot);
		expect(readEntry().projectRoots).toHaveLength(1);
	});

	it("getInstanceRoots folds a pre-#2130 entry back to its scalar root", async () => {
		const { getInstanceRoots } =
			await import("../../clients/instance-registry.js");
		const legacy = {
			pid: 1,
			startedAt: "2026-08-26T00:00:00.000Z",
			projectRoot: "/legacy/root",
			lspChildren: [],
			lspChildCount: 0,
			rssBytes: 0,
			heartbeatAt: "2026-08-26T00:00:00.000Z",
		};
		expect(getInstanceRoots(legacy)).toEqual(["/legacy/root"]);
	});

	it("getInstanceRoots drops non-string members from a torn file", async () => {
		const { getInstanceRoots } =
			await import("../../clients/instance-registry.js");
		const torn = {
			pid: 1,
			startedAt: "2026-08-26T00:00:00.000Z",
			projectRoot: "/a",
			projectRoots: ["/a", "", null, 7, "/b"] as unknown as string[],
			lspChildren: [],
			lspChildCount: 0,
			rssBytes: 0,
			heartbeatAt: "2026-08-26T00:00:00.000Z",
		};
		expect(getInstanceRoots(torn)).toEqual(["/a", "/b"]);
	});

	it("the root set is capped, and the cap never evicts the primary", async () => {
		const { registerInstance, getInstanceRoots } =
			await import("../../clients/instance-registry.js");
		await registerInstance(realRoot);
		for (let i = 0; i < 40; i++) {
			await registerInstance(path.join(tempRoot, `wt-${i}`));
		}
		const entry = readEntry();
		const roots = getInstanceRoots(entry as never);
		expect(roots.length).toBeLessThanOrEqual(32);
		expect(roots[0]).toContain(path.basename(realRoot));
		expect(entry.projectRoot).toContain(path.basename(realRoot));
	});

	describe("scoped deregistration", () => {
		it("removes one root and leaves the rest of the entry alive", async () => {
			const { registerInstance, deregisterInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			await registerInstance(tempRoot);
			deregisterInstanceRoot(tempRoot);

			const entry = readEntry();
			expect(entry.projectRoots).toHaveLength(1);
			expect(entry.projectRoots?.[0]).toContain(path.basename(realRoot));
		});

		it("promotes the next root when the primary is the one removed", async () => {
			const { registerInstance, deregisterInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			await registerInstance(tempRoot);
			deregisterInstanceRoot(realRoot);
			expect(readEntry().projectRoot).toContain(path.basename(tempRoot));
		});

		it("removing the LAST root removes the whole entry", async () => {
			const { registerInstance, deregisterInstanceRoot, readInstanceRegistry } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			deregisterInstanceRoot(realRoot);
			expect(await readInstanceRegistry()).toEqual([]);
		});

		it("deregistering an unknown root writes nothing", async () => {
			const { registerInstance, deregisterInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			const before = fs.readFileSync(path.join(dir, "instances.json"), "utf-8");
			deregisterInstanceRoot(tempRoot);
			expect(fs.readFileSync(path.join(dir, "instances.json"), "utf-8")).toBe(
				before,
			);
		});
	});

	describe("selectLivePeerInstances sees SECONDARY roots (#2007 / #2107)", () => {
		function peerEntry(roots: string[]) {
			return {
				pid: process.pid + 1,
				startedAt: new Date().toISOString(),
				projectRoot: roots[0],
				projectRoots: roots,
				lspChildren: [],
				lspChildCount: 0,
				rssBytes: 0,
				heartbeatAt: new Date().toISOString(),
			};
		}

		it("exact match finds a peer registered under its SECOND root", async () => {
			const { selectLivePeerInstances } =
				await import("../../clients/instance-registry.js");
			const { normalizeFilePath } = await import("../../clients/path-utils.js");
			const peer = peerEntry([
				normalizeFilePath(realRoot),
				normalizeFilePath(tempRoot),
			]);
			const found = selectLivePeerInstances(
				[peer],
				tempRoot,
				Date.now(),
				() => true,
				"exact",
			);
			expect(found).toHaveLength(1);
		});

		it("containment match finds a subdirectory of a SECOND root", async () => {
			const { selectLivePeerInstances } =
				await import("../../clients/instance-registry.js");
			const { normalizeFilePath } = await import("../../clients/path-utils.js");
			const peer = peerEntry([
				normalizeFilePath(realRoot),
				normalizeFilePath(tempRoot),
			]);
			const found = selectLivePeerInstances(
				[peer],
				path.join(tempRoot, "clients"),
				Date.now(),
				() => true,
				"containment",
			);
			expect(found).toHaveLength(1);
		});

		it("an unrelated root still matches nothing", async () => {
			const { selectLivePeerInstances } =
				await import("../../clients/instance-registry.js");
			const { normalizeFilePath } = await import("../../clients/path-utils.js");
			const peer = peerEntry([normalizeFilePath(realRoot)]);
			expect(
				selectLivePeerInstances(
					[peer],
					tempRoot,
					Date.now(),
					() => true,
					"exact",
				),
			).toHaveLength(0);
		});
	});
});
