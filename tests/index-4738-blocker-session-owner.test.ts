/**
 * #4738: the `turn-end-findings` record holds every session's blocker
 * sections, each with its owner, and a session's own new evidence replaces
 * only its own sections.
 *
 * The defect: the record was one slot with one owner. A second session's
 * blocker write (`syncGitGuardRecord`'s entries branch at `tool_result`, then
 * the turn-end composer) replaced the first session's blocker sections with
 * its own, without re-checking the files they name. Once the second session
 * fixed its own blocker, its record emptied and `git commit` under
 * `--lens-guard` ran with the first session's blocker never re-checked.
 *
 * Tier 2 (#4632): the BUILT extension in a real pi `AgentSession`, the model
 * scripted at the provider boundary, and the second session made by pi's own
 * `newSession` (`PiSession.restart({ reason: "new" })`, a new session id).
 * The first session's blocker is raised by the first session's own write of
 * a file whose bundled rule blocks; no record is seeded.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	RAN_MARKER,
	type Received,
	commitAttempt,
	endTurn,
	openGuardedSession,
	raise,
	seed,
	step,
	toolResults,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import { type PiSession, piSessionFixture } from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Two real pi sessions a cell; the other two-session files budget 60 s. */
const TWO_SESSION_TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;

function lastBash(handle: PiSession): Received {
	const results = toolResults(
		(handle.requests.at(-1) ?? []) as Parameters<typeof toolResults>[0],
		"bash",
	);
	return results.at(-1) ?? { text: "(no bash result)", isError: false };
}

/** Move the record's timestamp back a day: past the freshness window. */
function ageRecord(proj: string): void {
	fs.writeFileSync(
		path.join(getProjectDataDir(proj), "cache", "turn-end-findings.meta.json"),
		JSON.stringify({ timestamp: new Date(Date.now() - DAY_MS).toISOString() }),
	);
}

/**
 * Session A raises a blocker in `src/target.ts` and ends its turn; session B
 * (pi's `newSession`) raises its own blocker in `src/other.ts`, ends the turn
 * `repeats` times with the same findings (the composer's dedupe rewrite runs
 * from the second), fixes `src/other.ts`, ends the turn, and commits.
 */
async function secondSessionFixesOnlyItsOwn(
	name: string,
	options: { repeats: number; dayOld: boolean },
): Promise<{ proj: string; verdict: Received; second: PiSession }> {
	const { proj, target } = seed(fixture.root, name, BLOCKING_FILE);
	const other = path.join(proj, "src", "other.ts");
	const first = await openGuardedSession(fixture.root, proj, raise(target));
	await first.prompt("raise the blocker");
	if (options.dayOld) ageRecord(proj);

	const raiseOwn = Array.from({ length: options.repeats }, () => [
		step(writeTarget(other, BLOCKING_FILE), "raising mine"),
		endTurn("raised"),
	]).flat();
	const second = await first.restart({ reason: "new" }, [
		...raiseOwn,
		step(writeTarget(other, CLEAN_FILE), "fixing mine"),
		endTurn("fixed"),
		step(commitAttempt(), "committing"),
		endTurn("done"),
	]);
	for (let turn = 0; turn < options.repeats; turn++) {
		await second.prompt("raise my own blocker");
	}
	await second.prompt("fix my own blocker");
	await second.prompt("commit it");
	return { proj, verdict: lastBash(second), second };
}

function expectRefusedOnTheFirstSessionsBlocker(verdict: Received): void {
	expect(verdict.text).toContain(GATE_BLOCK);
	expect(verdict.text).not.toContain(RAN_MARKER);
	expect(verdict.isError).toBe(true);
	// The refusal names the first session's file, the one nothing re-checked.
	expect(verdict.text).toContain(path.join("src", "target.ts"));
}

describe("#4738: a second session's blocker write keeps the first session's blocker", () => {
	it(
		"refuses the commit on the first session's blocker after the second session fixes only its own",
		async () => {
			// RECURRENCE GUARDED: #4738 (PR #4733's p2 residual). The second
			// session's own blocker write replaced the first session's section, so
			// fixing its own blocker emptied the record and the commit ran.
			const { verdict, second } = await secondSessionFixesOnlyItsOwn(
				"fresh-record",
				{ repeats: 1, dayOld: false },
			);
			expectRefusedOnTheFirstSessionsBlocker(verdict);
			expect(second.errors).toEqual([]);
		},
		TWO_SESSION_TIMEOUT_MS,
	);

	it(
		"keeps the first session's blocker through the composer's repeated-findings rewrite",
		async () => {
			// RECURRENCE GUARDED: #4738, the dedupe writer (`clients/runtime-turn.ts`,
			// the duplicate-findings branch): it rewrote the record from this
			// session's blocker parts alone.
			const { verdict, second } = await secondSessionFixesOnlyItsOwn(
				"repeated-turn",
				{ repeats: 2, dayOld: false },
			);
			expectRefusedOnTheFirstSessionsBlocker(verdict);
			expect(second.errors).toEqual([]);
		},
		TWO_SESSION_TIMEOUT_MS,
	);

	it(
		"keeps a day-old first-session blocker that the composer read through the freshness window",
		async () => {
			// RECURRENCE GUARDED: #4738, the composer read the record through the
			// cache's freshness window, so a day-old record was invisible to it and
			// its write replaced the record whole.
			const { verdict, second } = await secondSessionFixesOnlyItsOwn(
				"day-old-record",
				{ repeats: 1, dayOld: true },
			);
			expectRefusedOnTheFirstSessionsBlocker(verdict);
			expect(second.errors).toEqual([]);
		},
		TWO_SESSION_TIMEOUT_MS,
	);
});
