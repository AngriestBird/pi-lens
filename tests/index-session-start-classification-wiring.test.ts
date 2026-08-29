/**
 * #2129 wiring. `tests/clients/session-start-total-classification.test.ts`
 * proves `handleSessionStart` logs `deps.sessionStartClassification`/
 * `sessionStartSameRoot` alongside `session_start_total`'s `mode` field. It
 * cannot prove index.ts's `session_start` handler actually SUPPLIES those
 * deps from `decideSessionStart`'s own decision — drop the two fields from
 * the call site and that unit test still passes. This file drives the real
 * handler through the pi mock, so a call site that stops threading the
 * decision through reds here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../index.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx, STALE_CTX_MESSAGE } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

const latencyCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../clients/latency-logger.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Record<string, unknown>) => {
			latencyCalls.push(entry);
		},
	};
});

/** Make an already-emitted ctx read as invalidated, the way the SDK does
 *  after a session replacement. */
function invalidate(ctx: unknown): void {
	Object.defineProperty(ctx as object, "isIdle", {
		configurable: true,
		get() {
			throw new Error(STALE_CTX_MESSAGE);
		},
	});
}

function sessionStartTotals() {
	return latencyCalls.filter((entry) => entry.phase === "session_start_total");
}

describe("index session_start wiring — classification logged with mode (#2129)", () => {
	let hostRoot: string;
	let previousStartupMode: string | undefined;

	beforeEach(() => {
		_resetSessionLifecycleForTests();
		latencyCalls.length = 0;
		previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-host-root-"));
	});

	afterEach(() => {
		_resetSessionLifecycleForTests();
		if (previousStartupMode === undefined) {
			delete process.env.PI_LENS_STARTUP_MODE;
		} else {
			process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
		}
		removeTempDirSync(hostRoot);
	});

	it("a fresh primary start's session_start_total carries classification=primary", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: hostRoot, sessionId: "host-session" }),
		);

		const totals = sessionStartTotals();
		expect(totals).toHaveLength(1);
		expect(totals[0].metadata).toMatchObject({
			mode: "quick",
			classification: "primary",
		});
	}, 30_000);

	it("a same-root sequential replacement carries classification + sameRoot:true", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		const first = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await pi.emit("session_start", makeSessionStartEvent(), first);
		invalidate(first);
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: hostRoot, sessionId: "host-session-2" }),
		);

		const totals = sessionStartTotals();
		expect(totals).toHaveLength(2);
		expect(totals[1].metadata).toMatchObject({
			mode: "quick",
			classification: "sequential-replacement",
			sameRoot: true,
		});
	}, 30_000);

	it("a declined temp-root start never reaches session_start_total", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const tempWorktree = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-agent-worktree-"),
		);
		try {
			const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
			await pi.emit("session_start", makeSessionStartEvent(), hostCtx);
			invalidate(hostCtx);
			await pi.emit(
				"session_start",
				makeSessionStartEvent(),
				makeCtx({ cwd: tempWorktree, sessionId: "subagent-session" }),
			);

			// Only the host's own start reached the full body; the declined
			// temp-root start returned before handleSessionStart ever ran.
			expect(sessionStartTotals()).toHaveLength(1);
		} finally {
			removeTempDirSync(tempWorktree);
		}
	}, 30_000);
});
