/**
 * Past-EOF validity gate — #1641.
 *
 * Live case: an LSP's in-memory document drifted longer than disk with no
 * disk write at all (402-line file, diagnostics cited lines 407-410). #1622's
 * mtime-based freshness gate cannot catch this — the file's mtime never
 * changed. The orthogonal, cheap check is structural: a cited line beyond the
 * file's CURRENT line count cannot describe current content, full stop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", () => ({ logLatency }));

import {
	createLineCountCache,
	demotePastEofDiagnostics,
	getCachedLineCount,
} from "../../clients/diagnostic-line-freshness.js";
import { setupTestEnvironment } from "./test-utils.js";

interface Diagnostic {
	line?: number;
	stale?: boolean;
	message: string;
}

describe("demotePastEofDiagnostics (#1641)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		cleanups.splice(0).forEach((cleanup) => cleanup());
		logLatency.mockReset();
	});

	function setup(prefix = "pi-lens-past-eof-") {
		const env = setupTestEnvironment(prefix);
		cleanups.push(env.cleanup);
		return env;
	}

	it("RED CASE: demotes a diagnostic citing a line past the file's current EOF", () => {
		const env = setup();
		// 402-line file, matching the live #1641 forensic case's line count.
		const filePath = path.join(env.tmpDir, "kilo.ts");
		fs.writeFileSync(filePath, Array.from({ length: 402 }, (_, i) => `// line ${i + 1}`).join("\n"));

		const diagnostics: Diagnostic[] = [
			{ line: 396, message: "kilo is defined here — still valid" },
			{ line: 407, message: "stale in-memory citation" },
			{ line: 410, message: "another stale in-memory citation" },
		];

		const result = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics,
			lineCountCache: createLineCountCache(),
		});

		expect(result.demotedCount).toBe(2);
		expect(result.diagnostics.find((d) => d.line === 396)?.stale).toBeFalsy();
		expect(result.diagnostics.find((d) => d.line === 407)?.stale).toBe(true);
		expect(result.diagnostics.find((d) => d.line === 410)?.stale).toBe(true);
	});

	it("emits one diagnostic_past_eof record naming file, cited lines, and actual line count", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "short.ts");
		fs.writeFileSync(filePath, "a\nb\nc\n"); // 3 lines

		demotePastEofDiagnostics({
			store: "lens_diagnostics",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 5, message: "past eof" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});

		expect(logLatency).toHaveBeenCalledTimes(1);
		const call = logLatency.mock.calls[0][0];
		expect(call.phase).toBe("diagnostic_past_eof");
		expect(call.metadata.store).toBe("lens_diagnostics");
		expect(call.metadata.file).toBe("short.ts");
		expect(call.metadata.actualLineCount).toBe(3);
		expect(call.metadata.demotedCount).toBe(1);
		expect(call.metadata.sampleCitedLines).toEqual([5]);
	});

	it("does NOT demote a diagnostic citing a line within the current file", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "ok.ts");
		fs.writeFileSync(filePath, "a\nb\nc\nd\ne\n"); // 5 lines

		const result = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 5, message: "on the last line" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});

		expect(result.demotedCount).toBe(0);
		expect(result.diagnostics[0]?.stale).toBeFalsy();
		expect(logLatency).not.toHaveBeenCalled();
	});

	it("fails OPEN (never demotes) when the file cannot be stat'ed", () => {
		const env = setup();
		const missing = path.join(env.tmpDir, "does-not-exist.ts");

		const result = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath: missing,
			diagnostics: [{ line: 999, message: "cannot be verified" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});

		expect(result.demotedCount).toBe(0);
		expect(result.diagnostics[0]?.stale).toBeFalsy();
		expect(logLatency).not.toHaveBeenCalled();
	});

	it("leaves an already-stale diagnostic untouched (never re-demotes / re-logs)", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "already-stale.ts");
		fs.writeFileSync(filePath, "a\nb\n"); // 2 lines

		const result = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 50, stale: true, message: "already demoted by another gate" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});

		expect(result.demotedCount).toBe(0);
		expect(logLatency).not.toHaveBeenCalled();
	});

	it("triggers the caller-supplied resync exactly once when something demotes", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "resync.ts");
		fs.writeFileSync(filePath, "a\nb\n");
		const resync = vi.fn();

		demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 99, message: "past eof" } as Diagnostic],
			lineCountCache: createLineCountCache(),
			resync,
		});

		expect(resync).toHaveBeenCalledTimes(1);
		expect(resync).toHaveBeenCalledWith(filePath);
	});

	it("does not trigger resync when nothing demotes", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "clean.ts");
		fs.writeFileSync(filePath, "a\nb\nc\n");
		const resync = vi.fn();

		demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 2, message: "fine" } as Diagnostic],
			lineCountCache: createLineCountCache(),
			resync,
		});

		expect(resync).not.toHaveBeenCalled();
	});

	it("a resync that throws never propagates out of the gate", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "resync-throws.ts");
		fs.writeFileSync(filePath, "a\n");
		const resync = vi.fn(() => {
			throw new Error("boom");
		});

		expect(() =>
			demotePastEofDiagnostics({
				store: "test",
				cwd: env.tmpDir,
				filePath,
				diagnostics: [{ line: 5, message: "past eof" } as Diagnostic],
				lineCountCache: createLineCountCache(),
				resync,
			}),
		).not.toThrow();
	});
});

describe("getCachedLineCount cost discipline (#1641)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

	it("a cache hit (matching mtime) returns the MEMOIZED count, not a fresh recount", () => {
		// Deterministic proof of the memo, without depending on a real write's
		// mtime round-tripping through `fs.utimesSync` at full precision (a
		// platform-specific hazard on its own, not what this test is about):
		// seed the pass-scoped cache with a fabricated entry at the file's REAL
		// current mtime but a count that could only come from the cache, then
		// confirm that's what's returned.
		const env = setupTestEnvironment("pi-lens-past-eof-cache-hit-");
		cleanups.push(env.cleanup);
		const filePath = path.join(env.tmpDir, "cached.ts");
		fs.writeFileSync(filePath, "a\nb\nc\n"); // really 3 lines
		const mtimeMs = fs.statSync(filePath).mtimeMs;

		const cache = createLineCountCache();
		cache.set(filePath, { mtimeMs, lineCount: 999 });
		expect(getCachedLineCount(filePath, cache)).toBe(999);
	});

	it("a cache miss (stale mtime in the memo) recounts from the CURRENT disk content", () => {
		const env = setupTestEnvironment("pi-lens-past-eof-cache-miss-");
		cleanups.push(env.cleanup);
		const filePath = path.join(env.tmpDir, "cached.ts");
		fs.writeFileSync(filePath, "a\nb\nc\nd\ne\n"); // 5 lines, current

		const cache = createLineCountCache();
		// A memo entry whose mtime does not match the file's real current mtime
		// must be ignored — it belongs to a PRIOR state of this file.
		cache.set(filePath, { mtimeMs: 1, lineCount: 999 });
		expect(getCachedLineCount(filePath, cache)).toBe(5);
	});

	it("a fresh cache from a new pass never inherits a prior pass's entries", () => {
		const env = setupTestEnvironment("pi-lens-past-eof-cache-fresh-");
		cleanups.push(env.cleanup);
		const filePath = path.join(env.tmpDir, "pass.ts");
		fs.writeFileSync(filePath, "a\nb\nc\nd\n");

		const firstPassCache = createLineCountCache();
		expect(getCachedLineCount(filePath, firstPassCache)).toBe(4);

		// A brand new pass (as every render/tool call creates) starts cold —
		// no cross-request state survives, by construction.
		const secondPassCache = createLineCountCache();
		expect(secondPassCache.size).toBe(0);
		expect(getCachedLineCount(filePath, secondPassCache)).toBe(4);
	});
});
