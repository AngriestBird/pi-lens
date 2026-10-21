/**
 * #4704 witness: the shared session teardown belongs to the LAST live session
 * in the PROCESS, not to the last live session of one extension activation.
 *
 * pi 1.3.0 runs the pi-lens factory once per session load
 * (`dist/core/extensions/loader.js` caches the factory, `initializeExtension`
 * calls it per load), so an in-process subagent is its own activation
 * (`docs/subagent-compat.md` contracts 2a and 3). Each `startPiSession` below
 * is that shape: a real `AgentSession` and its own activation. On the pre-fix
 * tree the primary's leave found its own activation empty and ran the shared
 * teardown: it removed the pid's whole registry entry (the live sibling's
 * root with it), released the primary registration and reset the LSP service
 * under the sibling, which kept running turns on nothing.
 *
 * Every observable is pi-lens's own process-wide state, read from this side
 * of the jiti copy because each lives in a process singleton or on disk: the
 * pid's `instances.json` roots, the primary registration
 * (`getActiveSessionId`), the owned LSP service object
 * (`peekOwnedLspService`), and the `session_teardown_last_member` row the
 * teardown leaves when it runs for a session classified secondary.
 */

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_settleRegistryMutationsForTests,
	getInstanceRoots,
	readInstanceRegistry,
} from "../clients/instance-registry.js";
import { peekOwnedLspService } from "../clients/lsp/service-singleton.js";
import { normalizeFilePath } from "../clients/path-utils.js";
import {
	_trackedLiveSessionListCountForTests,
	getActiveSessionId,
} from "../clients/session-lifecycle.js";
import {
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
	type PiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

// This side's registry read resolves `PI_LENS_HOME` per call. Pin it to the
// home the copy writes (`startPiSession` pins the same path), so no read here
// reaches the worker's home, even one made before a case's first start.
let previousHome: string | undefined;
beforeEach(() => {
	previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = path.join(fixture.root, "home");
});
afterEach(() => {
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
});

/** The record the shared teardown leaves when it runs for a secondary. */
const LAST_MEMBER_PHASE = "session_teardown_last_member";

/** The roots this pid's registry entry holds, after the queued writes land. */
async function rootsForThisPid(): Promise<string[]> {
	await _settleRegistryMutationsForTests();
	const entry = (await readInstanceRegistry()).find(
		(candidate) => candidate.pid === process.pid,
	);
	return entry ? getInstanceRoots(entry) : [];
}

/** A primary and a live sibling, each its own activation, in two roots. */
async function primaryAndSibling(caseName: string): Promise<{
	primary: PiSession;
	sibling: PiSession;
	primaryRoot: string;
	siblingRoot: string;
}> {
	const primary = await startPiSession({
		root: fixture.root,
		cwd: path.join(fixture.root, caseName, "primary"),
		responses: [fauxAssistantMessage(fauxText("primary ok"))],
	});
	const sibling = await startPiSession({
		root: fixture.root,
		cwd: path.join(fixture.root, caseName, "sibling"),
		responses: [fauxAssistantMessage(fauxText("sibling ok"))],
	});
	// The registry stores roots through `normalizeFilePath`, so compare in
	// that form (a native path differs from it on Windows).
	return {
		primary,
		sibling,
		primaryRoot: normalizeFilePath(primary.cwd),
		siblingRoot: normalizeFilePath(sibling.cwd),
	};
}

/**
 * The teardown-for-a-secondary rows the copy wrote for these sessions. The
 * file shares one home, so `latency.log` also holds earlier cases' rows.
 */
async function lastMemberRows(...sessions: PiSession[]): Promise<unknown[]> {
	const ids = new Set(
		sessions.map((handle) => handle.session.sessionManager.getSessionId()),
	);
	const { rows } = await sessions[0]!.latencyRows();
	return rows
		.filter((row) => (row as { phase?: string }).phase === LAST_MEMBER_PHASE)
		.map((row) => (row as { metadata?: { sessionId?: string } }).metadata)
		.filter((metadata) => ids.has(metadata?.sessionId ?? ""));
}

/** The ledger rows that name a live session dropped with no shutdown. */
async function disposedMemberRows(session: PiSession): Promise<unknown[]> {
	const { rows } = await session.latencyRows();
	return rows
		.filter((row) => (row as { phase?: string }).phase === "degradation_ledger")
		.map((row) => (row as { metadata?: { kind?: string } }).metadata)
		.filter((metadata) => metadata?.kind === "session-member-disposed");
}

describe("#4704 a primary and a sibling on separate activations", () => {
	it("keeps the sibling's root, the primary registration and the LSP service when the primary leaves first", async () => {
		const { primary, sibling, primaryRoot, siblingRoot } =
			await primaryAndSibling("primary-first");
		const primaryId = primary.session.sessionManager.getSessionId();
		expect(getActiveSessionId()).toBe(primaryId);
		expect(await rootsForThisPid()).toEqual(
			expect.arrayContaining([primaryRoot, siblingRoot]),
		);
		const service = peekOwnedLspService();
		expect(service).toBeDefined();

		await primary.dispose();

		// The sibling is live, so nothing shared was released: its root, the
		// primary registration it still runs behind, and the LSP service
		// object it drives (a reset would have replaced it with nothing).
		expect(await rootsForThisPid()).toEqual(
			expect.arrayContaining([primaryRoot, siblingRoot]),
		);
		expect(getActiveSessionId()).toBe(primaryId);
		expect(peekOwnedLspService()).toBe(service);

		await sibling.prompt("still here");
		expect(sibling.errors).toEqual([]);
		expect(sibling.requests).toHaveLength(1);
		expect(peekOwnedLspService()).toBe(service);
	}, 60_000);

	it("releases the entry, the registration and the LSP service once the sibling leaves last", async () => {
		const { primary, sibling } = await primaryAndSibling("sibling-last");
		const siblingId = sibling.session.sessionManager.getSessionId();
		await primary.dispose();
		expect(await lastMemberRows(sibling)).toEqual([]);

		await sibling.dispose();

		// The last live session's leave runs the one shared teardown, on behalf
		// of a session classified secondary: no leak once both are gone.
		expect(await rootsForThisPid()).toEqual([]);
		expect(getActiveSessionId()).toBeUndefined();
		expect(peekOwnedLspService()).toBeUndefined();
		// Neither activation's member list outlives its last member.
		expect(_trackedLiveSessionListCountForTests()).toBe(0);
		expect(await lastMemberRows(sibling)).toEqual([
			expect.objectContaining({
				sessionId: siblingId,
				classification: "secondary",
			}),
		]);
	}, 60_000);

	it("releases only the sibling's own root when the sibling leaves first", async () => {
		const { primary, sibling, primaryRoot, siblingRoot } =
			await primaryAndSibling("sibling-first");
		const primaryId = primary.session.sessionManager.getSessionId();
		const service = peekOwnedLspService();

		await sibling.dispose();

		const afterSibling = await rootsForThisPid();
		expect(afterSibling).toContain(primaryRoot);
		expect(afterSibling).not.toContain(siblingRoot);
		expect(getActiveSessionId()).toBe(primaryId);
		expect(peekOwnedLspService()).toBe(service);

		await primary.dispose();

		expect(await rootsForThisPid()).toEqual([]);
		expect(getActiveSessionId()).toBeUndefined();
		expect(peekOwnedLspService()).toBeUndefined();
		// The primary ran its own teardown: no row for a secondary's.
		expect(await lastMemberRows(primary, sibling)).toEqual([]);
		// Both left through a shutdown, so neither counts as disposed.
		expect(await disposedMemberRows(primary)).toEqual([]);
	}, 60_000);

	it("does not count a sibling pi disposed without a shutdown as live", async () => {
		// pi's `AgentSession.dispose()` invalidates the session's extension
		// contexts and emits no `session_shutdown`; a subagent runner that
		// disposes its session that way never reaches pi-lens's leave. Such a
		// sibling must not hold the shared infra past its primary.
		const { primary, sibling } = await primaryAndSibling("disposed-sibling");
		sibling.session.dispose();

		await primary.dispose();

		expect(await rootsForThisPid()).toEqual([]);
		expect(getActiveSessionId()).toBeUndefined();
		expect(peekOwnedLspService()).toBeUndefined();
		// The disposed sibling's list (and the context it pins) is dropped,
		// not kept for the life of the process, and the drop is recorded once.
		expect(_trackedLiveSessionListCountForTests()).toBe(0);
		expect(await disposedMemberRows(primary)).toEqual([
			expect.objectContaining({ subject: "no-shutdown", count: 1 }),
		]);
	}, 60_000);
});
