/**
 * #2992: the read and mutation bridges under a STALE host context.
 *
 * The bridges read pi-lens's own flags through `pi.getFlag` on the `pi` object
 * the current activation captured. pi invalidates that captured object when a
 * session is replaced (`ExtensionRunner.invalidate`, the exact call
 * `AgentSession.dispose()` makes), and every later call on it throws the host's
 * stale-ctx error. The bridge must treat the flag as unset rather than turn the
 * throw into a false "Edit without read", and it must disclose that fallback
 * once per bridge per session instead of once per call.
 *
 * Claims (tier 2, #4632 slice 9): PROCESSING. Every case runs a real
 * `AgentSession` over the built extension, calls the process-global bridge the
 * LOADED copy mounted, and reads what the loaded copy's own writer queued into
 * its `latency.log` (`handle.latencyRows()`, drained before the read). The
 * staleness is pi's, not a test double's: `ExtensionRunner.invalidate()` is the
 * method `AgentSession.dispose()` calls, with its own default message.
 *
 * The reads are recorded, not merely attempted: a bridge read that cannot be
 * booked is disclosed as `io-bridge-read-dropped`, so this file asserts that
 * row's ABSENCE where the read is expected to land, which is what makes a later
 * edit authorized rather than blocked. `clients/io-bridge.ts` owns that record.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

type Row = Record<string, unknown>;

/**
 * The `session_start_total` rows for one project directory. The fixture home is
 * shared by every case in the file, so the ROW's own `filePath` (the start's
 * cwd) is what scopes a claim to its session.
 */
function startTotalsFor(rows: Row[], cwd: string): Row[] {
	return rows.filter(
		(row) => row.phase === "session_start_total" && row.filePath === cwd,
	);
}

/**
 * A session in the fixture at its own cwd, past `session_start`. The one total
 * row it must have written is the case's own anchor: a start pi-lens DECLINED
 * writes none, so no case below can pass on a session the classifier refused.
 */
async function sessionIn(name: string) {
	const cwd = path.join(fixture.root, name, "proj");
	const handle = await startPiSession({
		root: fixture.root,
		cwd,
		startupMode: "quick",
		responses: [fauxAssistantMessage(fauxText("ready"))],
	});
	await handle.prompt("hello");
	expect(startTotalsFor((await handle.latencyRows()).rows, cwd)).toHaveLength(
		1,
	);
	return handle;
}

/** A recordable file inside the LOADED copy's project root. */
function projectFile(cwd: string, name: string): string {
	const filePath = path.join(cwd, name);
	fs.writeFileSync(filePath, "export const guarded = true;\n");
	return filePath;
}

/** The `degradation_ledger` rows a run wrote, as their metadata. */
function degradations(rows: Row[]): Array<Record<string, unknown>> {
	return rows
		.filter((row) => row.phase === "degradation_ledger")
		.map((row) => row.metadata as Record<string, unknown>);
}

/** The two bridges the loaded copy mounts, as a process-global producer sees them. */
function bridges(): {
	read?: { recordRead(entry: unknown): void };
	mutate?: { recordMutation(entry: unknown): boolean };
} {
	const globals = globalThis as Record<symbol, unknown>;
	return {
		read: globals[Symbol.for("pi-lens:read-bridge")] as
			| { recordRead(entry: unknown): void }
			| undefined,
		mutate: globals[Symbol.for("pi-lens:mutation-bridge")] as
			| { recordMutation(entry: unknown): boolean }
			| undefined,
	};
}

describe("#2992 bridge lifecycle under a stale host ctx", () => {
	// The session-lifecycle registration is process-global, so a previous case's
	// shutdown leaves a successor marker behind and this case's start would be
	// DECLINED as `concurrent-secondary` — a start pi's loader would not rebind
	// the bridge to. Reset it, as the classification wiring file does.
	beforeEach(() => {
		_resetSessionLifecycleForTests();
	});

	it("discloses the stale flag read once and still books the read", async () => {
		const handle = await sessionIn("stale-read");
		const readBridge = bridges().read;
		expect(readBridge).toBeDefined();
		const filePath = projectFile(handle.cwd, "guarded.ts");
		const record = () =>
			readBridge?.recordRead({
				filePath,
				requestedOffset: 1,
				requestedLimit: 1,
			});

		// The subjects are the discriminator: the shared fixture home also holds
		// other cases' and other subsystems' rows, so each claim names its own.
		const staleReadRecords = (rows: Row[]) =>
			degradations(rows).filter((row) => row.subject === "read-bridge");

		// Negative control: the same call against the LIVE ctx books no stale
		// record, so the row below is the invalidation's, not theirs.
		for (let i = 0; i < 5; i += 1) record();
		const liveWindow = (await handle.latencyRows()).rows;
		expect(staleReadRecords(liveWindow)).toEqual([]);
		const mark = liveWindow.length;

		// pi's own invalidation, with pi's own message. Every `pi.*` call on the
		// captured object throws from here on.
		handle.session.extensionRunner.invalidate();
		for (let i = 0; i < 100; i += 1) record();

		const window = (await handle.latencyRows()).rows.slice(mark);
		// ONE record for a hundred stale calls: the ledger's once-per-subject
		// bound, not a count of the calls.
		expect(staleReadRecords(window)).toEqual([
			expect.objectContaining({
				kind: "extension-ctx-stale",
				subject: "read-bridge",
				count: 1,
			}),
		]);
		// The fallback kept the reads bookable: a bridge read that cannot be
		// booked is disclosed as `io-bridge-read-dropped` instead.
		expect(
			window
				.filter((row) => row.phase === "degradation_ledger")
				.map((row) => (row.metadata as Record<string, unknown>).kind),
		).not.toContain("io-bridge-read-dropped");
	}, 60_000);

	it("bounds repeated stale mutation-bridge records without dropping the write", async () => {
		const handle = await sessionIn("stale-mutation");
		const mutationBridge = bridges().mutate;
		expect(mutationBridge).toBeDefined();
		const filePath = projectFile(handle.cwd, "mutated.ts");
		const staleMutationRecords = (rows: Row[]) =>
			degradations(rows).filter((row) => row.subject === "mutation-bridge");
		const mark = (await handle.latencyRows()).rows.length;

		handle.session.extensionRunner.invalidate();
		const accepted: boolean[] = [];
		for (let i = 0; i < 100; i += 1) {
			accepted.push(
				mutationBridge?.recordMutation({
					filePath,
					kind: "edit",
					touchedLines: [1, 1],
					deferAutofix: false,
				}) ?? false,
			);
		}

		// Treating the flag as unset keeps the read-guard stamp on, so the write
		// is booked (`true`), not dropped as "no-read-guard".
		expect(accepted.every((value) => value)).toBe(true);
		const window = (await handle.latencyRows()).rows.slice(mark);
		expect(staleMutationRecords(window)).toEqual([
			expect.objectContaining({
				kind: "extension-ctx-stale",
				subject: "mutation-bridge",
				count: 1,
			}),
		]);
	}, 60_000);

	it("rethrows a near-match stale failure at both bridge boundaries", async () => {
		const handle = await sessionIn("near-match");
		const { read: readBridge, mutate: mutationBridge } = bridges();
		const filePath = projectFile(handle.cwd, "near.ts");

		// A message that is NOT the host's stale text must never be swallowed:
		// the producer has to see it. `invalidate` takes the message, so this is
		// the host's own throw with a near-match wording.
		handle.session.extensionRunner.invalidate(
			"stale after session replacement",
		);

		expect(() =>
			readBridge?.recordRead({
				filePath,
				requestedOffset: 1,
				requestedLimit: 1,
			}),
		).toThrow("stale after session replacement");
		expect(
			mutationBridge?.recordMutation({
				filePath,
				kind: "edit",
				touchedLines: [1, 1],
				deferAutofix: false,
			}),
		).toBe(false);
	}, 60_000);
});
