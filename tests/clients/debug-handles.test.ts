import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";

function debugHandlesLogPath(): string {
	return path.join(getGlobalPiLensDir(), "debug-handles.log");
}

/**
 * `clients/debug-handles.ts` reads `PI_LENS_DEBUG_HANDLES` ONCE at module
 * load (institutionalizing the #1097 hand-rolled tracer, #1123 item 4). Every
 * test in this file must `vi.resetModules()` and set the env var BEFORE the
 * dynamic `import()` — setting it after import (like most `process.env.*`
 * reads elsewhere in this repo) would not take effect, by design: the whole
 * point is a flag baked in at startup, not re-read per call.
 *
 * `PI_LENS_HOME` is already pointed at a per-worker temp dir by
 * `tests/support/vitest-setup.ts`, so `getGlobalPiLensDir()` (which
 * `debug-handles.log` is written under) is hermetic with no extra setup here.
 */

async function importFresh(enabled: boolean) {
	vi.resetModules();
	if (enabled) {
		process.env.PI_LENS_DEBUG_HANDLES = "1";
	} else {
		delete process.env.PI_LENS_DEBUG_HANDLES;
	}
	return import("../../clients/debug-handles.js");
}

describe("debug-handles: PI_LENS_DEBUG_HANDLES=1 unset (default)", () => {
	let originalFlag: string | undefined;

	beforeEach(() => {
		originalFlag = process.env.PI_LENS_DEBUG_HANDLES;
	});

	afterEach(() => {
		if (originalFlag === undefined) delete process.env.PI_LENS_DEBUG_HANDLES;
		else process.env.PI_LENS_DEBUG_HANDLES = originalFlag;
		vi.resetModules();
	});

	it("isDebugHandlesEnabled() is false", async () => {
		const mod = await importFresh(false);
		expect(mod.isDebugHandlesEnabled()).toBe(false);
	});

	it("dumpActiveHandles is a no-op — writes nothing to disk", async () => {
		const mod = await importFresh(false);
		mod.dumpActiveHandles("agent_settled");
		mod.dumpActiveHandles("session_shutdown");
		await mod.flushDebugHandlesLog();
		expect(fs.existsSync(mod.getDebugHandlesLogPath())).toBe(false);
	});

	it("installs no async_hooks tracker — the tracked-resource count stays 0", async () => {
		const mod = await importFresh(false);
		mod._simulateTrackedInitForTest(1, "Timeout");
		expect(mod._trackedResourceCountForTest()).toBe(0);
	});
});

describe("debug-handles: PI_LENS_DEBUG_HANDLES=1 set at startup", () => {
	let originalFlag: string | undefined;

	beforeEach(() => {
		originalFlag = process.env.PI_LENS_DEBUG_HANDLES;
		fs.rmSync(debugHandlesLogPath(), { force: true });
	});

	afterEach(() => {
		if (originalFlag === undefined) delete process.env.PI_LENS_DEBUG_HANDLES;
		else process.env.PI_LENS_DEBUG_HANDLES = originalFlag;
		vi.resetModules();
	});

	it("isDebugHandlesEnabled() is true", async () => {
		const mod = await importFresh(true);
		expect(mod.isDebugHandlesEnabled()).toBe(true);
	});

	it("dumpActiveHandles emits one ndjson line with type counts and the given label", async () => {
		const mod = await importFresh(true);
		mod.dumpActiveHandles("agent_settled");
		await mod.flushDebugHandlesLog();

		const raw = fs.readFileSync(mod.getDebugHandlesLogPath(), "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]);
		expect(entry.label).toBe("agent_settled");
		expect(typeof entry.total).toBe("number");
		expect(typeof entry.counts).toBe("object");
		expect(typeof entry.ts).toBe("string");
	});

	it("dumps at both wired labels independently, appending both lines", async () => {
		const mod = await importFresh(true);
		mod.dumpActiveHandles("agent_settled");
		mod.dumpActiveHandles("session_shutdown");
		await mod.flushDebugHandlesLog();

		const raw = fs.readFileSync(mod.getDebugHandlesLogPath(), "utf-8");
		const labels = raw
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line).label);
		expect(labels).toEqual(["agent_settled", "session_shutdown"]);
	});

	it("includes creationSites attribution once the tracker has tracked resources", async () => {
		const mod = await importFresh(true);
		mod._simulateTrackedInitForTest(101, "Timeout");
		mod._simulateTrackedInitForTest(102, "Timeout");
		mod._simulateTrackedInitForTest(103, "TCPSOCKETWRAP");
		mod.dumpActiveHandles("agent_settled");
		await mod.flushDebugHandlesLog();

		const raw = fs.readFileSync(mod.getDebugHandlesLogPath(), "utf-8");
		const entry = JSON.parse(raw.split("\n").filter(Boolean)[0]);
		expect(Array.isArray(entry.creationSites)).toBe(true);
		const byType = Object.fromEntries(
			(entry.creationSites as { type: string; count: number }[]).map((s) => [
				s.type,
				s.count,
			]),
		);
		expect(byType.Timeout).toBe(2);
		expect(byType.TCPSOCKETWRAP).toBe(1);
	});

	it("the async_hooks tracker map is bounded: the cap drops the oldest entry", async () => {
		const mod = await importFresh(true);
		for (let i = 0; i < mod.TRACKER_MAX_ENTRIES + 50; i++) {
			mod._simulateTrackedInitForTest(i, "Timeout");
		}
		expect(mod._trackedResourceCountForTest()).toBe(mod.TRACKER_MAX_ENTRIES);
	});

	it("ignores untracked async_hooks resource types (no unbounded growth from noise)", async () => {
		const mod = await importFresh(true);
		for (let i = 0; i < 20; i++) {
			mod._simulateTrackedInitForTest(i, "PROMISE");
		}
		expect(mod._trackedResourceCountForTest()).toBe(0);
	});
});
