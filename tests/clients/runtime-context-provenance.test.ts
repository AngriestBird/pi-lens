import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	advisoryPathKey,
	snapshotAdvisoryProvenance,
	validateAdvisoryProvenance,
} from "../../clients/advisory-provenance.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	peekTestFindings,
	consumeTurnEndFindings,
	peekTurnEndFindings,
} from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("advisory provenance at context delivery (#1413)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

	function setup() {
		const env = setupTestEnvironment("pi-lens-advisory-");
		cleanups.push(env.cleanup);
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-a" });
		const cache = new CacheManager(false);
		const file = path.join(env.tmpDir, "src", "file.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "export const value = 1;\n");
		const provenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 7,
			files: [{ path: file, role: "affected" }],
		});
		return { env, runtime, cache, file, provenance };
	}

	it("uses the guard normalizer for Windows and POSIX separators", () => {
		expect(advisoryPathKey("C:\\repo\\src\\file.ts", "C:\\repo"))
			.toBe(advisoryPathKey("C:/repo/src/file.ts", "C:/repo"));
	});

	it("keeps exact-hash findings blocking and peek classifies like consume", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		const peeked = peekTurnEndFindings(cache, env.tmpDir, runtime);
		const consumed = consumeTurnEndFindings(cache, env.tmpDir, runtime);
		expect(peeked).toEqual(consumed);
		expect(consumed?.messages[0]?.content).toContain("Address 🔴 blockers");
		expect(consumed?.messages[0]?.content).not.toContain("Historical finding");
	});

	it("keeps unchanged blockers live across beginTurn and project sequence drift", () => {
		const { env, runtime, cache, file, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		runtime.beginTurn();
		runtime.bumpFileSeq(file);
		const consumed = consumeTurnEndFindings(cache, env.tmpDir, runtime);
		expect(consumed?.messages[0]?.content).toContain("Address ");
		expect(consumed?.messages[0]?.content).not.toContain("Historical finding");
	});

	it("demotes an edit made after persistence", () => {
		const { env, runtime, cache, file, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		fs.writeFileSync(file, "export const value = 2;\n");
		expect(consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content)
			.toContain("Historical finding; workspace changed since capture; re-run to confirm.");
	});

	it("hash-detects same-size same-mtime rewrites", () => {
		const { env, runtime, cache, file, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		fs.writeFileSync(file, "export const value = 2;\n");
		fs.utimesSync(file, provenance.files[0]!.mtimeMs / 1000, provenance.files[0]!.mtimeMs / 1000);
		expect(fs.statSync(file).size).toBe(provenance.files[0]!.size);
		expect(consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content)
			.toContain("Historical finding");
	});

	it("treats legacy records and session mismatches as historical", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "legacy" }, env.tmpDir);
		expect(consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content)
			.toContain("generation unknown");
		cache.writeCache("turn-end-findings", { content: "mismatch", provenance }, env.tmpDir);
		runtime.setTelemetryIdentity({ sessionId: "session-b" });
		expect(consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content)
			.toContain("Historical finding");
	});

	it("treats missing-to-missing as unchanged and validation read failures as unknown", () => {
		const { env, runtime, file } = setup();
		const absent = path.join(env.tmpDir, "never-created.ts");
		const missingProvenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 1,
			files: [{ path: absent, role: "affected" }],
		});
		expect(validateAdvisoryProvenance({ provenance: missingProvenance }, env.tmpDir, runtime))
			.toMatchObject({ status: "current", reasons: [] });

		const provenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 2,
			files: [{ path: file, role: "affected" }],
		});
		fs.unlinkSync(file);
		fs.mkdirSync(file);
		expect(validateAdvisoryProvenance({ provenance }, env.tmpDir, runtime).status).toBe("unknown");
	});

	it("does not duplicate the historical preamble on prior-turn test content", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("test-runner-findings", {
			content: "[from a prior turn — already superseded]\n\nfailure",
			provenance,
		}, env.tmpDir);
		runtime.setTelemetryIdentity({ sessionId: "other-session" });
		const content = peekTestFindings(cache, env.tmpDir, runtime)?.messages[0]?.content ?? "";
		expect(content).toContain("[from a prior turn");
		expect(content).not.toContain("Historical finding");
	});

	it("preserves structured commit-gate state when consumed", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", {
			content: "blocker",
			hasBlockers: true,
			sessionId: "session-a",
			blockerContent: "structured blocker",
			provenance,
		}, env.tmpDir);
		consumeTurnEndFindings(cache, env.tmpDir, runtime);
		const persisted = cache.readCache<Record<string, unknown>>("turn-end-findings", env.tmpDir)?.data;
		expect(persisted).toMatchObject({ consumed: true, blockerContent: "structured blocker" });
	});
});
