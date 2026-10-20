/**
 * Wiring guard for the #1123 item 2 periodic memory sample: the extension emits
 * exactly one `memory_sample` latency record every `MEMORY_SAMPLE_TURN_INTERVAL`
 * turns (the coordinator's turn index, bumped by the host's `turn_start`),
 * never on turns in between and never on turn 0.
 *
 * Slice 8 of #4632 moved this off `tests/support/pi-mock.ts` onto tier 2
 * (`tests/support/pi-session.ts`): a real pi `AgentSession` over the BUILT
 * extension, driven by real prompts, with pi-ai's `fauxProvider` at the
 * provider boundary. The record is read from the sink the LOADED copy's own
 * writer queued, so the cadence is asserted against a run of real turns rather
 * than against a handler this test invoked itself. The old double stubbed
 * `handleTurnEnd` and captured `logLatency`; both are gone, so a turn that
 * never reaches the production path cannot pass here.
 *
 * WHAT EACH CASE ASSERTS (#4632 "shape or processing"):
 *
 * - `processing`: the host's turn loop, at the sampler's own interval, produces
 *   the record — turns 1–9 produce none.
 * - `shape`: the record the loaded copy wrote — `phase`, `metadata.turnIndex`,
 *   the process block and the session block (#1999's session-age/turn-count
 *   ridealong).
 * - `processing`: the cadence, not a one-shot — turn 20 writes the second one.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	fauxText,
	piSessionFixture,
	startPiSession,
	type PiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** The sampler's interval, as the record's own `turnIndex` reports it. */
const MEMORY_SAMPLE_TURN_INTERVAL = 10;

/** One `memory_sample` row per turn the sampler considered. */
function samplesIn(rows: readonly Record<string, unknown>[]) {
	return rows.filter((row) => row.phase === "memory_sample");
}

/**
 * Run `turns` real turns and return the `memory_sample` rows THIS run produced.
 * The file shares one pinned home, so a case diffs against the rows already
 * there: `latencyRows()` returns them in write order and a prompt only appends.
 */
async function driveTurns(
	handle: PiSession,
	turns: number,
): Promise<Array<Record<string, unknown>>> {
	const before = (await handle.latencyRows()).length;
	for (let turn = 0; turn < turns; turn += 1) {
		// One scripted reply per turn, so `prompt` resolves on a real request.
		await handle.prompt(`turn ${turn + 1}`);
	}
	return samplesIn((await handle.latencyRows()).slice(before));
}

async function startSession(turns: number): Promise<PiSession> {
	return startPiSession({
		root: fixture.root,
		// One project directory per case keeps the session state of a case
		// out of its neighbours' project data.
		cwd: path.join(fixture.root, `memory-sample-${turns}`, "proj"),
		responses: Array.from({ length: turns }, () => fauxText("ok")),
	});
}

// #1778: the cold `index.js` import this file used to pay is gone with the
// double, but a 20-turn case still starts a session, loads the built copy and
// writes its own project state, so the budget stays generous.
const MEMORY_SAMPLE_WIRING_TIMEOUT_MS = 30_000;

describe(
	"turn_end memory_sample cadence through the real session (#1123 item 2)",
	{ timeout: MEMORY_SAMPLE_WIRING_TIMEOUT_MS },
	() => {
		it("emits nothing before turn 10 (the host's turn_start bumps the index)", async () => {
			const handle = await startSession(MEMORY_SAMPLE_TURN_INTERVAL - 1);
			const samples = await driveTurns(handle, MEMORY_SAMPLE_TURN_INTERVAL - 1);
			// `processing`: nine real turns reach the sampler, which declines.
			expect(samples).toHaveLength(0);
		});

		it("emits exactly one memory_sample on turn 10, with process + subsystems metadata", async () => {
			const handle = await startSession(MEMORY_SAMPLE_TURN_INTERVAL);
			const samples = await driveTurns(handle, MEMORY_SAMPLE_TURN_INTERVAL);
			expect(samples).toHaveLength(1);
			const metadata = samples[0].metadata as Record<string, unknown>;
			// `shape`: what the loaded copy's sampler wrote into the record.
			expect(metadata.turnIndex).toBe(10);
			expect(metadata.process).toBeDefined();
			expect(metadata.subsystems).toBeDefined();
			const proc = metadata.process as Record<string, number>;
			expect(proc.rssBytes).toBeGreaterThan(0);
			// #1999: session-age + turn-count ridealong for growth-vs-age curves.
			const session = metadata.session as Record<string, number>;
			expect(session.sessionAgeMs).toBeGreaterThanOrEqual(0);
			expect(session.turnCount).toBe(10);
			expect(handle.errors).toEqual([]);
		});

		it("emits again on turn 20 but not on turns 11-19 (cadence, not a one-shot)", async () => {
			const handle = await startSession(MEMORY_SAMPLE_TURN_INTERVAL * 2);
			const samples = await driveTurns(handle, MEMORY_SAMPLE_TURN_INTERVAL * 2);
			// `processing`: the second interval fires exactly once more.
			expect(samples).toHaveLength(2);
			expect((samples[0].metadata as Record<string, unknown>).turnIndex).toBe(
				10,
			);
			expect((samples[1].metadata as Record<string, unknown>).turnIndex).toBe(
				20,
			);
		});
	},
);
