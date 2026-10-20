/**
 * The contract of the tier-2 helper itself (#4632): a real `AgentSession` over
 * the BUILT extension, a scripted provider at the boundary, in process.
 *
 * Every assertion below reads a value only pi or the loaded copy produces —
 * pi's own transcript roles and content blocks, the tool result the loaded
 * copy's tool returned, the session file pi wrote, the log rows the loaded
 * copy's writers queued — never a value this test's setup supplied.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { flushAllNdjsonWriters } from "../../clients/ndjson-logger.js";
import {
	getActivePrimaryRoot,
	getActiveSessionId,
} from "../../clients/session-lifecycle.js";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./pi-session.js";

const fixture = piSessionFixture();
// No per-case handle list here: the helper registers every session it creates
// and disposes the live ones in its own `afterEach`, so a case that fails
// before `dispose()` cannot leak one (#4664 M2).

/** The delimiter pi-lens prefixes every injected context block with. */
const INJECTION_DELIMITER = "[pi-lens automated context — not a user request]";

/**
 * A settled call as plain text: its rejection's message, or `resolved`. A
 * resolved restart is a handle over pi's session, and vitest cannot print one
 * (it reads pi's uninitialised theme Proxy and throws `Theme not
 * initialized`), so a `rejects` matcher would hide what the call did.
 */
async function outcome(call: Promise<unknown>): Promise<string> {
	return call.then(
		() => "resolved",
		(error: unknown) =>
			error instanceof Error ? error.message : String(error),
	);
}

function textBlocks(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		const typed = block as { type?: string; text?: string };
		return typed.type === "text" && typeof typed.text === "string"
			? [typed.text]
			: [];
	});
}

describe("pi-session: the built extension in a real AgentSession (#4632)", () => {
	it("runs session_start and a turn through the loaded copy", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "turn", "proj"),
			responses: [fauxAssistantMessage(fauxText("ready"))],
		});

		await handle.prompt("hello");

		// One prompt, one provider round trip: the request count is pi's own.
		expect(handle.requests).toHaveLength(1);
		const transcript = handle.requests[0];
		expect(transcript[0]).toMatchObject({ role: "system" });
		expect(transcript.at(-1)).toMatchObject({ role: "user" });
		expect(JSON.stringify(transcript.at(-1))).toContain("hello");

		// No handler error from the loaded copy.
		expect(handle.errors).toEqual([]);
		// The start persisted a session, so the resume seam has a file to open.
		expect(handle.sessionFile()).toMatch(/\.jsonl$/);
	});

	it("runs a tool call through pi's own tool loop", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "tool-loop", "proj"),
			responses: [
				fauxAssistantMessage([
					fauxText("checking"),
					fauxToolCall("lens_diagnostics", { paths: [] }),
				]),
				fauxAssistantMessage(fauxText("done")),
			],
		});

		await handle.prompt("check this project");

		// The tool call took a second provider round trip, and pi sent the
		// result of the LOADED copy's tool back to the model.
		expect(handle.requests).toHaveLength(2);
		const second = handle.requests[1];
		expect(second.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
		]);
		const toolResult = second[3] as { content?: unknown; isError?: unknown };
		const resultText = textBlocks(toolResult.content).join("\n");
		// The diagnostics tool's own answer, not a value this test supplied.
		expect(resultText).toContain("No issues in the current turn delta.");
		expect(toolResult.isError).toBeFalsy();
	});

	it("reopens the persisted session file for the next turn", async () => {
		const first = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "resume", "proj"),
			responses: [fauxAssistantMessage(fauxText("first answer"))],
		});
		await first.prompt("first question");

		const resumed = await first.resume([
			fauxAssistantMessage(fauxText("second answer")),
		]);
		await resumed.prompt("second question");

		// pi restored the transcript from the file, then appended the new turn:
		// the resumed process sees the earlier conversation, which is the whole
		// point of the resume axis.
		const transcript = resumed.requests[0];
		expect(transcript.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
		]);
		expect(textBlocks(transcript[1].content).join("\n")).toContain(
			"first question",
		);
		expect(textBlocks(transcript[2].content).join("\n")).toContain(
			"first answer",
		);
		expect(textBlocks(transcript[3].content).join("\n")).toContain(
			"second question",
		);
		// The resumed session continued the SAME conversation identity.
		expect(resumed.session.sessionManager.getSessionId()).toBe(
			first.session.sessionManager.getSessionId(),
		);
	});

	it("runs the loaded copy's shutdown handler when dispose() emits session_shutdown", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "tee", "proj"),
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});
		await handle.prompt("hello");
		// The start registered this session as the process primary, in state the
		// LOADED copy's own graph holds (a `getProcessSingleton` cell, so this
		// graph reads the same one). Removing the emit from `dispose()` reds the
		// release below — and that, not the log row, is what separates "the
		// handler ran" from "a writer drained on its own": `flushAllNdjsonWriters`
		// reaches the same process-global sinks from either side, so the row
		// lands either way (#4664 F2).
		const sessionId = handle.session.sessionManager.getSessionId();
		expect(getActiveSessionId()).toBe(sessionId);

		await handle.dispose();

		expect(getActiveSessionId()).toBeUndefined();
		expect(getActivePrimaryRoot()).toBeUndefined();
		expect(handle.errors).toEqual([]);

		// The row the copy's writer queued is on disk under the home the copy
		// pinned — the sink a later case would read, settled when `dispose()`
		// returns.
		const latencyLog = path.join(process.env.PI_LENS_HOME ?? "", "latency.log");
		await flushAllNdjsonWriters();
		const rows = fs
			.readFileSync(latencyLog, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { phase?: string });
		expect(rows.some((row) => row.phase === "session_start_total")).toBe(true);
	});

	it("refuses a manual compaction the fixture transcript is too small for", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "compact", "proj"),
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});
		await handle.prompt("hello");

		// pi's compaction entry point is reachable from this tier and answers
		// through its own precondition (`prepareCompaction`); a case that wants
		// a real summary needs a transcript past that threshold, which the
		// fixture-sized sessions this batch runs are not.
		await expect(handle.compact()).rejects.toThrow("Nothing to compact");
	});

	it("injects its session-start guidance through the provider request", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "guidance", "proj"),
			responses: [fauxAssistantMessage(fauxText("ok"))],
		});
		await handle.prompt("hello");

		// The guidance pi-lens staged at `session_start` reaches the model on
		// the first request — appended to the prompt, not as its own message.
		const transcript = handle.requests[0];
		expect(transcript).toHaveLength(2);
		const blocks = textBlocks(transcript[1].content);
		expect(blocks[0]).toBe("hello");
		expect(blocks[1]).toContain(INJECTION_DELIMITER);
		expect(blocks[1]).toContain("pi-lens active");
	});

	it("replaces the session: the old conversation ends, and the next one starts empty under a new id", async () => {
		const first = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "replace", "proj"),
			responses: [fauxAssistantMessage(fauxText("first answer"))],
		});
		await first.prompt("first question");
		const firstId = first.session.sessionManager.getSessionId();
		const firstFile = first.sessionFile();
		expect(getActiveSessionId()).toBe(firstId);

		const second = await first.restart({ reason: "new" }, [
			fauxAssistantMessage(fauxText("second answer")),
		]);
		const secondId = second.session.sessionManager.getSessionId();

		// A replacement is a DIFFERENT conversation: pi minted a new session id,
		// so nothing that keys on the session identity can cross it by accident.
		expect(secondId).not.toBe(firstId);
		// The old conversation's own state was released, and the new one binds its
		// own provider script.
		expect(second.requests).toHaveLength(0);
		expect(second.errors).toEqual([]);

		// The new conversation starts empty: pi restored nothing from the old
		// session file, which is still on disk under the first id.
		await second.prompt("second question");
		expect(second.requests[0].map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(fs.readFileSync(firstFile ?? "", "utf8")).toContain("first answer");
	});

	it("starts the replacement as a primary once the old session's shutdown named it", async () => {
		// pi's own teardown runs the old session's `session_shutdown` handler
		// with `targetSessionFile`, which leaves the primary slot pending for
		// that successor; the next start claims it. Nothing process-wide is
		// reset, because pi resets nothing (round 1 did, to make up for a
		// shutdown event without `targetSessionFile`: #4692 H2). This is also
		// the witness that the shutdown RAN: without it the old primary stays a
		// live member, and pi-lens's #473 classifier declines the next start as
		// a `concurrent-secondary`, so the active id stays the old one.
		const first = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "replace-primary", "proj"),
			responses: [fauxAssistantMessage(fauxText("one"))],
		});
		await first.prompt("hello");
		const firstId = first.session.sessionManager.getSessionId();

		const second = await first.restart({ reason: "new" }, [
			fauxAssistantMessage(fauxText("two")),
		]);
		await second.prompt("hello again");
		const secondId = second.session.sessionManager.getSessionId();

		// The replacement took the primary slot the previous conversation left.
		expect(secondId).not.toBe(firstId);
		expect(getActiveSessionId()).toBe(secondId);
		expect(getActivePrimaryRoot()).toBe(
			path.join(fixture.root, "replace-primary", "proj"),
		);
		expect(second.errors).toEqual([]);
	});

	it("refuses a replacement it cannot run through pi, and a restart of a handle already replaced", async () => {
		const first = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "replace-refused", "proj"),
			responses: [fauxAssistantMessage(fauxText("one"))],
		});
		await first.prompt("hello");
		const firstId = first.session.sessionManager.getSessionId();

		// A reason with no pi entry point here fails closed BEFORE pi tears the
		// session down: no synthesised event, and the session stays live.
		expect(
			await outcome(first.restart({ reason: "quit" } as never, [])),
		).toContain("no faithful replacement");
		expect(getActiveSessionId()).toBe(firstId);

		// A handle being replaced cannot be restarted beside it: the overlapping
		// call would build a second replacement while the first is still in
		// flight (Sourcery T3). Its refusal must leave the first to complete.
		const pending = first.restart({ reason: "new" }, [
			fauxAssistantMessage(fauxText("two")),
		]);
		expect(await outcome(first.restart({ reason: "new" }, []))).toContain(
			"being replaced",
		);
		// A replaced handle cannot be restarted again: that would build a third
		// session beside the live replacement and take its identity (#4692 L2).
		const second = await pending;
		const secondId = second.session.sessionManager.getSessionId();
		expect(secondId).not.toBe(firstId);
		expect(await outcome(first.restart({ reason: "new" }, []))).toContain(
			"already ended",
		);
		expect(getActiveSessionId()).toBe(secondId);
	});

	it("refuses a second fixture root in one file", async () => {
		// A session under a SECOND fixture root writes into the FIRST root's home
		// and nothing into its own — measured: 78 `session_start` rows against 0
		// — while its own fixture path still gets a `home/` directory. The helper
		// fails closed instead of running a case that observes nothing. Where the
		// copy binds that first home is not isolated, and it is demonstrably NOT
		// `clients/probe-home-state.ts`, which re-reads `PI_LENS_HOME` per call
		// (#4664 F4).
		await expect(
			startPiSession({
				root: path.join(fixture.root, "a-second-root"),
				responses: [fauxAssistantMessage(fauxText("never"))],
			}),
		).rejects.toThrow("one fixture root per test file");
	});
});
