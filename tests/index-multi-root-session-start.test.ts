/**
 * #2129 wiring: index.ts's `session_start` handler passes the START'S OWN
 * PROJECT ROOT into `decideSessionStart`.
 *
 * The unit tests in `tests/clients/session-lifecycle-multi-root.test.ts` prove
 * the classifier. They cannot prove the caller supplies the root — drop the
 * argument at the call site and every one of them still passes. This file
 * drives the real handler through the pi mock, so a call site that stops
 * reading `ctx.cwd` reds here.
 *
 * The observable is `getSecondarySessionCount()`: a start that is declined
 * increments it, and a start that steals the primary does not.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.js";
import {
	_resetSessionLifecycleForTests,
	getActivePrimaryRoot,
	getSecondarySessionCount,
} from "../clients/session-lifecycle.js";
import {
	deregisterInstance,
	getInstanceRoots,
	readInstanceRegistry,
	registerInstance,
} from "../clients/instance-registry.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx, STALE_CTX_MESSAGE } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

/** Make an already-emitted ctx read as invalidated, the way the SDK does after
 *  a session replacement — the state a subagent temp worktree's session_start
 *  actually arrives in. */
function invalidate(ctx: unknown): void {
	Object.defineProperty(ctx as object, "isIdle", {
		configurable: true,
		get() {
			throw new Error(STALE_CTX_MESSAGE);
		},
	});
}

/** The roots this process's registry entry currently holds. */
async function rootsForThisPid(): Promise<string[]> {
	const entry = (await readInstanceRegistry()).find(
		(candidate) => candidate.pid === process.pid,
	);
	return entry ? getInstanceRoots(entry) : [];
}

describe("session_start keys on the project root (#2129 wiring)", () => {
	let hostRoot: string;
	let tempWorktree: string;

	beforeEach(() => {
		_resetSessionLifecycleForTests();
		// The registry entry is keyed by pid, so it survives between tests in
		// this file and roots would accumulate across them.
		deregisterInstance();
		hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-host-root-"));
		tempWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-worktree-"));
	});

	afterEach(() => {
		_resetSessionLifecycleForTests();
		removeTempDirSync(hostRoot);
		removeTempDirSync(tempWorktree);
	});

	it("declines a temp worktree's start behind a disposed primary", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await pi.emit("session_start", makeSessionStartEvent(), hostCtx);
		expect(getSecondarySessionCount()).toBe(0);
		expect(getActivePrimaryRoot()).toContain(path.basename(hostRoot));

		// The host's session is replaced; its ctx goes stale. A subagent then
		// binds a session in a temp worktree.
		invalidate(hostCtx);
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tempWorktree, sessionId: "subagent-session" }),
		);

		// Declined, and the host's root is still the process's primary.
		expect(getSecondarySessionCount()).toBe(1);
		expect(getActivePrimaryRoot()).toContain(path.basename(hostRoot));
		expect(getActivePrimaryRoot()).not.toContain(path.basename(tempWorktree));
	}, 30_000);

	/**
	 * Two extension instances in one process — the real concurrent-secondary
	 * shape (#473). `ownedSessionRole` is per-instance closure state, so a
	 * secondary needs its own `extension()` call; the module-scope lifecycle
	 * state they share is exactly the seam the guard reads.
	 *
	 * The second root is registered by hand: a declined start never calls
	 * `registerInstance`, so this stands in for the producer that does reach it
	 * (a guard-disabled or root-unknown start).
	 */
	async function bindSecondaryIn(cwd: string) {
		const host = createPiMock();
		extension(host.asExtensionAPI());
		const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await host.emit("session_start", makeSessionStartEvent(), hostCtx);
		await registerInstance(hostRoot);
		await registerInstance(tempWorktree);

		const secondary = createPiMock();
		extension(secondary.asExtensionAPI());
		await secondary.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd, sessionId: "sibling-session" }),
		);
		expect(getSecondarySessionCount()).toBe(1);
		return secondary;
	}

	it("a secondary's shutdown drops only its OWN root (#2130)", async () => {
		const secondary = await bindSecondaryIn(tempWorktree);
		expect(await rootsForThisPid()).toHaveLength(2);

		await secondary.emit(
			"session_shutdown",
			{},
			makeCtx({ cwd: tempWorktree, sessionId: "sibling-session" }),
		);

		const roots = await rootsForThisPid();
		expect(roots).toHaveLength(1);
		expect(roots[0]).toContain(path.basename(hostRoot));
	}, 30_000);

	it("a secondary sharing the host's root drops nothing (#2130)", async () => {
		// The scoped deregistration is positively-different-root only. A
		// secondary in the SAME directory that dropped it would delete the
		// registry root the host is still working in.
		const secondary = await bindSecondaryIn(hostRoot);

		await secondary.emit(
			"session_shutdown",
			{},
			makeCtx({ cwd: hostRoot, sessionId: "sibling-session" }),
		);

		expect(await rootsForThisPid()).toHaveLength(2);
	}, 30_000);

	it("still runs a same-root replacement as the primary", async () => {
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

		// Same root: today's behavior is unchanged — the replacement is primary.
		expect(getSecondarySessionCount()).toBe(0);
		expect(getActivePrimaryRoot()).toContain(path.basename(hostRoot));
	}, 30_000);
});
