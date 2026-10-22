/**
 * #4751: a session pi starts with `newSession` owns its own turn-end scope.
 *
 * The defect: the turn-state worklist (`turn-state.json`) has two readers of
 * one identity. `handleTurnEnd` classifies its session by the LIVE role (the
 * successor is the primary, so it reads the top-level envelope), while the
 * writer (`CacheManager.addModifiedRange` → `resolveTurnStatePartition`)
 * classifies by the PERSISTED envelope owner. A departing primary keeps that
 * envelope for successor replay, so after `newSession` its owner still named
 * the first session, the successor's write was filed under a secondary's
 * partition, and every turn end of the successor logged "no modified files":
 * its writes composed no turn-end findings and no turn-end blocker section.
 *
 * Tier 2 (#4632): the BUILT extension in a real pi `AgentSession`, the model
 * scripted at the provider boundary, the second session made by pi's own
 * `newSession` (`PiSession.restart({ reason: "new" })`, a new session id).
 * Each session raises its blocker by its own write; nothing is seeded.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	BLOCKING_FILE,
	endTurn,
	openGuardedSession,
	raise,
	seed,
	step,
	textBlocks,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import { type PiSession, piSessionFixture } from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Two real pi sessions; the other two-session files budget 60 s. */
const TWO_SESSION_TIMEOUT_MS = 60_000;

interface BlockerSection {
	sessionId: string;
	blockerContent: string;
	blockingFiles: string[];
}

interface GuardRecord {
	sessionId?: string;
	blockerContent?: string;
	blockingFiles?: string[];
	carriedBlockers?: BlockerSection[];
}

function readRecord(proj: string): GuardRecord {
	const file = path.join(
		getProjectDataDir(proj),
		"cache",
		"turn-end-findings.json",
	);
	return JSON.parse(fs.readFileSync(file, "utf8")) as GuardRecord;
}

/** Every `user`-role text the model received in one request, prompts included. */
function userTexts(handle: PiSession): string[] {
	return (handle.requests.at(-1) ?? [])
		.filter((message) => message.role === "user")
		.flatMap((message) => textBlocks(message));
}

/**
 * Session A raises a blocker in `src/target.ts`; session B (pi's
 * `newSession`) writes a blocking `src/other.ts`, ends that turn, and runs one
 * more turn, whose request carries whatever B's first turn end composed.
 */
async function newSessionWritesABlocker(name: string): Promise<{
	proj: string;
	first: string;
	second: PiSession;
}> {
	const { proj, target } = seed(fixture.root, name, BLOCKING_FILE);
	const other = path.join(proj, "src", "other.ts");
	const firstSession = await openGuardedSession(
		fixture.root,
		proj,
		raise(target),
	);
	await firstSession.prompt("raise the blocker");
	const first = firstSession.session.sessionManager.getSessionId();
	const second = await firstSession.restart({ reason: "new" }, [
		step(writeTarget(other, BLOCKING_FILE), "raising mine"),
		endTurn("raised"),
		endTurn("listening"),
	]);
	await second.prompt("raise my own blocker");
	await second.prompt("anything else?");
	return { proj, first, second };
}

describe("#4751: a session pi starts with newSession owns its own turn-end scope", () => {
	it(
		"delivers the new session's turn-end findings for its own write and records its section under its id",
		async () => {
			// RECURRENCE GUARDED: #4751. After newSession the successor's write
			// went to a secondary's partition, so its turn end saw no modified
			// file: the model got no turn-end findings for src/other.ts and the
			// record held only the tool_result copy of B's blocker.
			const { proj, first, second } = await newSessionWritesABlocker("fresh");
			const secondId = second.session.sessionManager.getSessionId();
			expect(secondId).not.toBe(first);

			// The model's next request carries B's turn-end findings, naming the
			// file B wrote. Only the turn-end composer writes this header.
			const delivered = userTexts(second).join("\n");
			expect(delivered).toContain(
				`Unresolved from this turn — ${path.join("src", "other.ts")}`,
			);
			expect(delivered).toContain("Debugger statement");

			// The record's lead section is B's, written by B's turn end; A's
			// section is carried unchanged (#4749).
			const record = readRecord(proj);
			expect(record.sessionId).toBe(secondId);
			expect(record.blockerContent).toContain(
				`Unresolved from this turn — ${path.join("src", "other.ts")}`,
			);
			expect(record.carriedBlockers).toEqual([
				expect.objectContaining({
					sessionId: first,
					blockingFiles: [path.join(proj, "src", "target.ts")],
				}),
			]);
			expect(record.carriedBlockers?.[0]?.blockerContent).toContain(
				`Unresolved from this turn — ${path.join("src", "target.ts")}`,
			);

			// One claim row per session, never one per turn: A took the fresh
			// project's empty worklist, then B took it from A.
			const { rows } = await second.latencyRows();
			const claims = rows.filter(
				(row) => row.phase === "session_handoff_turn_state",
			);
			expect(claims).toEqual([
				expect.objectContaining({
					metadata: { arm: "empty", filesKept: 0, to: first },
				}),
				expect.objectContaining({
					metadata: expect.objectContaining({
						from: first,
						to: secondId,
						arm: "predecessor",
						filesKept: 0,
					}),
				}),
			]);
			expect(second.errors).toEqual([]);
		},
		TWO_SESSION_TIMEOUT_MS,
	);
});
