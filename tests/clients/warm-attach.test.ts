import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import type { InstanceEntry } from "../../clients/instance-registry.js";
import { STALE_HEARTBEAT_MS } from "../../clients/instance-reaper.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { selectWarmAttachIncumbent } from "../../clients/warm-attach.js";
import {
	_resetWarmAttachForTests,
	_setWarmAttachForTests,
	isWarmAttached,
	tryWarmAttachedCodeActions,
	tryWarmAttachedDiagnostics,
} from "../../clients/warm-attach.js";
import { removeTempDirSync } from "./test-utils.js";

function entry(pid: number, root: string, heartbeatAt: string): InstanceEntry {
	return {
		pid,
		startedAt: heartbeatAt,
		projectRoot: normalizeFilePath(root),
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 1,
		heartbeatAt,
	};
}

describe("selectWarmAttachIncumbent", () => {
	const now = Date.now();
	const cwd = "C:\\work\\same-root";

	it("selects a PID-confirmed live same-root incumbent", () => {
		const incumbent = entry(11, cwd, new Date(now).toISOString());
		expect(
			selectWarmAttachIncumbent([incumbent], cwd, now, () => true)?.pid,
		).toBe(11);
	});

	it("rejects stale, dead, different-root, and absent incumbents", () => {
		const stale = entry(
			11,
			cwd,
			new Date(now - STALE_HEARTBEAT_MS - 1).toISOString(),
		);
		const dead = entry(12, cwd, new Date(now).toISOString());
		const other = entry(13, "C:\\work\\other", new Date(now).toISOString());
		expect(
			selectWarmAttachIncumbent(
				[stale, dead, other],
				cwd,
				now,
				(pid) => pid !== 12,
			),
		).toBeUndefined();
		expect(selectWarmAttachIncumbent([], cwd, now, () => true)).toBeUndefined();
	});

	it("permanently promotes to local when the incumbent disappears", async () => {
		_setWarmAttachForTests(cwd, 999_999);
		expect(isWarmAttached()).toBe(true);
		await tryWarmAttachedDiagnostics("app.ts", "x", 10);
		expect(isWarmAttached()).toBe(false);
		await tryWarmAttachedDiagnostics("app.ts", "x", 10);
		expect(isWarmAttached()).toBe(false);
		_resetWarmAttachForTests();
	});

	it("does not promote when optional code-action enrichment fails", async () => {
		_setWarmAttachForTests(cwd, 999_998);
		expect(isWarmAttached()).toBe(true);
		const result = await tryWarmAttachedCodeActions(
			"app.ts",
			"diagnostics-hash",
			[],
			10,
		);
		expect(result?.available).toBe(false);
		expect(isWarmAttached()).toBe(true);
		_resetWarmAttachForTests();
	});
});

/**
 * #3255 H1. Narrowing the case fold moved the derived endpoint bytes, so a peer
 * that registered BEFORE the upgrade is still alive and still listening on its
 * old pid-scoped socket while this process derives the new one. Round 1 shipped
 * that as an ordinary promote-to-local: the session silently lost its warm
 * incumbent with nothing a user could read. The ledger entry is what
 * `/lens-perf` renders (index.ts:1550, the same renderer `pilens_health` uses),
 * so this is the existing surface, not a new one.
 */
describe("warm-attach records a missing incumbent endpoint (#3255)", () => {
	let home: string;
	const savedHome = process.env.PI_LENS_HOME;
	const root = path.resolve("/repo/warm-attach-3255");

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-warm-3255-"));
		process.env.PI_LENS_HOME = home;
		// A live, same-root incumbent the registry confirms: this process itself,
		// so `isPidAlive` is true without mocking it. Nothing listens on its
		// derived endpoint — which is exactly the upgrade-stranded shape.
		fs.writeFileSync(
			path.join(home, "instances.json"),
			JSON.stringify({
				instances: [entry(process.pid, root, new Date().toISOString())],
			}),
		);
		resetDegradationLedger();
		_setWarmAttachForTests(root, process.pid);
	});

	afterEach(() => {
		_resetWarmAttachForTests();
		resetDegradationLedger();
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
		removeTempDirSync(home);
	});

	it("records the missing endpoint exactly once across repeated calls", async () => {
		await tryWarmAttachedDiagnostics("app.ts", "x", 200);
		await tryWarmAttachedDiagnostics("app.ts", "x", 200);

		const group = getDegradationSummary().find(
			(candidate) => candidate.kind === "warm-ipc-endpoint-missing",
		);
		expect(group?.count).toBe(1);
		// The reason has to name the remedy, not just the failure: after an
		// upgrade the incumbent is alive and answering on its PREVIOUS endpoint
		// name, so "no peer" would send the reader looking for a dead process.
		expect(group?.latestReasons[0]?.reason).toMatch(/restart/i);
		expect(isWarmAttached()).toBe(false);
	});
});
