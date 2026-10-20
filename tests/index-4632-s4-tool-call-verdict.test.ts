/**
 * Slice 4 of #4632: the `tool_call` hook's verdict as the MODEL receives it.
 *
 * The claim every case here pins is the hook's RESULT, not the hook's return
 * value: pi turns a `{ block: true, reason }` answer into the tool result the
 * model reads on its next request, and the tool never runs. A double that
 * records what `index.ts` PASSED to a handler cannot see either half — it can
 * only compare the object it was handed with the object it expected.
 *
 * Two families moved here from the doubles that stood in for the host:
 *
 * 1. The commit gate (#3248's witness,
 *    `tests/index-3248-git-guard-latch-witness.test.ts`). The blocker is now
 *    the BUNDLED rules' own answer on a real file (`debugger;` raises an
 *    ast-grep and a code-quality blocking finding), so `clients/pipeline.ts` —
 *    the previous double — is the real one, and the bytes the gate re-reads
 *    are the bytes the pipeline analysed.
 * 2. The inline half of #3814's session-boundary cells
 *    (`tests/index-3814-deferred-blocker-gate.test.ts`): a record written in
 *    one session must answer a commit in the NEXT session as a refusal, never
 *    as allowed. Here the second session is pi's own replacement — a new
 *    session id, pi's own `session_start` — instead of a re-emitted event on
 *    one process-lifetime activation, which is why the old cells could pass on
 *    an in-memory latch alone.
 *
 * What stays on the double, and why: #3814's deferred half. A deferred runner
 * is a LATENCY classification (`clients/dispatch/collect-later-tier.ts`), so
 * producing one needs a real runner observed over 5 s; its blocker cannot be
 * scripted at the provider boundary. Those cells keep `clients/pipeline.js`
 * stubbed and their `in-process-mock` baseline row.
 *
 * ORDER MATTERS IN THE SCRIPT: one tool call per scripted reply. Tool calls
 * sharing one assistant message are handed to the host together, so a commit
 * written into the same message as the edit it must judge can reach the
 * `tool_call` hook before that edit's `tool_result` recorded its blocker —
 * measured. Each reply below therefore carries at most one call.
 *
 * The commit verb carries a marker (`echo`) after a `;`: a blocked call never
 * reaches the shell, so the marker's ABSENCE is the observable that the tool
 * did not execute, and its presence in an allowed turn is the observable that
 * it did. The marker keeps that assertion true whether git refuses the commit
 * or creates one, so the case does not depend on the checkout it runs in.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type PiFauxReply,
	type PiMessage,
	type PiSession,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/**
 * The flag set these cases run with: the helper's defaults plus the commit
 * gate. LSP is off because the blocker under test is a bundled rule's, not a
 * language server's; a case that wanted an LSP finding belongs to a heavier
 * lane than this one.
 */
const GUARDED_FLAGS: ReadonlyArray<[string, boolean]> = [
	["lens-guard", true],
	["no-lsp", true],
	["no-autofix", true],
	["no-autoformat", true],
	["no-tests", true],
	["no-opengrep", true],
	["no-delta", true],
	["no-complexity", true],
];

/**
 * The blocker, and its fix. `debugger;` is blocked by two bundled rules at
 * once (ast-grep's `debugger-statement` and `lint/suspicious/noDebugger`), so
 * the STOP text carries two findings with no external binary involved.
 */
const BLOCKING_FILE =
	"const a = 1;\nexport function f() {\n\tdebugger;\n\treturn a;\n}\n";
const CLEAN_FILE = "const a = 1;\nexport function f() {\n\treturn a;\n}\n";

/** The commit gate's own prefix, as the model reads it. */
const GATE_BLOCK = "🔴 COMMIT BLOCKED (--lens-guard)";
/** Printed by the shell only when the guarded command actually ran. */
const RAN_MARKER = "PI-LENS-GUARDED-COMMAND-RAN";

const GOLDEN = path.join(
	import.meta.dirname,
	"fixtures/witness/git-guard-latch/tool-call-verdict.txt",
);

/** The commit attempt: the guarded verb, then a marker the shell prints. */
function commitAttempt(): Record<string, unknown> {
	return fauxToolCall("bash", {
		command: `git commit -m "wip"; echo ${RAN_MARKER}`,
	});
}

function readTarget(target: string): Record<string, unknown> {
	return fauxToolCall("read", { path: target });
}

function writeTarget(target: string, content: string): Record<string, unknown> {
	return fauxToolCall("write", { path: target, content });
}

function editTarget(
	target: string,
	oldText: string,
	newText: string,
): Record<string, unknown> {
	return fauxToolCall("edit", {
		path: target,
		edits: [{ oldText, newText }],
	});
}

/** One scripted step: at most ONE tool call, so its result lands first. */
function step(call: Record<string, unknown>, note = "working"): PiFauxReply {
	return fauxAssistantMessage([fauxText(note), call]);
}

/** A turn-closing step: no tool call, so the host emits `turn_end`. */
function endTurn(note = "done"): PiFauxReply {
	return fauxAssistantMessage(fauxText(note));
}

/** Every text block of one message, in order. */
function textBlocks(message: PiMessage | undefined): string[] {
	const content = message?.content;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		const typed = block as { type?: string; text?: string };
		return typed.type === "text" && typeof typed.text === "string"
			? [typed.text]
			: [];
	});
}

/** One tool result, as the model received it. */
interface Received {
	readonly text: string;
	readonly isError: boolean;
}

function received(message: PiMessage): Received {
	const typed = message as { content?: unknown; isError?: unknown };
	return {
		text: textBlocks({ role: "toolResult", content: typed.content })
			.join("\n")
			.trim(),
		isError: typed.isError === true,
	};
}

/**
 * Every `bash` tool result the model received, in order. Read from the LAST
 * transcript only: each provider request carries the whole conversation, so
 * folding every request would count one result once per later round trip.
 */
function bashResults(requests: readonly (readonly PiMessage[])[]): Received[] {
	const transcript = requests.at(-1) ?? [];
	return transcript
		.filter(
			(message) => message.role === "toolResult" && message.toolName === "bash",
		)
		.map(received);
}

/** The first `L<n>: …` blocker line in a rendered finding block. */
function firstBlockerLine(text: string): string | undefined {
	return text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => /^L\d+: /.test(line));
}

/** The prefix pi-lens puts on every context block it injects. */
const INJECTION_PREFIX = "[pi-lens automated";

/**
 * Every injection the model read in one transcript, in order. pi delivers a
 * `context` block either beside the prompt's own text (the session-start
 * guidance) or as a user message of its own (a turn-end delivery), so the
 * marker is the block's own text, never its position.
 */
function injections(transcript: readonly PiMessage[]): string[] {
	return transcript
		.filter((message) => message.role === "user")
		.flatMap((message) => textBlocks(message))
		.filter((text) => text.startsWith(INJECTION_PREFIX));
}

/** The last injection the model read in one transcript. */
function lastInjection(transcript: readonly PiMessage[]): string {
	return injections(transcript).at(-1) ?? "(nothing injected)";
}

/** A file written before the session starts, in a project of its own. */
function seed(name: string, content: string): { proj: string; target: string } {
	const proj = path.join(fixture.root, name, "proj");
	const target = path.join(proj, "src", "target.ts");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return { proj, target };
}

async function open(
	proj: string,
	responses: readonly PiFauxReply[],
): Promise<PiSession> {
	return startPiSession({
		root: fixture.root,
		cwd: proj,
		flags: new Map(GUARDED_FLAGS),
		responses,
	});
}

describe("#4632 s4: a blocked tool_call reaches the model (git guard)", () => {
	it("shows the model the blocker and blocks the commit, then lets it through once the blocker is fixed", async () => {
		const { proj, target } = seed("gate-golden", CLEAN_FILE);
		const handle = await open(proj, [
			// Turn 1: raise the blockers, then try to commit them.
			step(readTarget(target), "reading"),
			step(writeTarget(target, BLOCKING_FILE), "writing"),
			step(commitAttempt(), "committing"),
			endTurn("turn 1 done"),
			// Turn 2: fix the file the blockers named, then commit again.
			step(editTarget(target, "\tdebugger;\n", ""), "fixing"),
			step(commitAttempt(), "committing again"),
			endTurn("turn 2 done"),
		]);

		await handle.prompt("write the file and commit it");
		const turnTwoStarts = handle.requests.length;

		await handle.prompt("fix it and commit again");

		const commits = bashResults(handle.requests);
		expect(commits).toHaveLength(2);
		const blocked = commits[0];
		const allowed = commits[1];
		// The injection the model reads on turn 2 is turn 1's, delivered through
		// pi's own `context` merge.
		// The delivery the model read BEFORE it attempted the commit: the inline
		// blocker notice lands on the request that carries the commit call, so the
		// two surfaces are compared at the same instant.
		const banner =
			handle.requests
				.slice(0, turnTwoStarts)
				.map((transcript) => lastInjection(transcript))
				.filter((text) => text !== "(nothing injected)")
				.at(-1) ?? "(nothing injected)";

		// The witness artifact: what the model was shown at turn end, and what the
		// gate answered a moment later. It records FACTS drawn from both texts
		// rather than the texts themselves: which bundled rules fire depends on
		// the tools installed (`debugger;` is caught by the ast-grep rule alone
		// where the code-quality runner is unavailable), so a raw golden would
		// pin the runner set instead of the verdict.
		const facts = (label: string, text: string) =>
			[
				`--- ${label} ---`,
				`names the gate's prefix: ${text.includes(GATE_BLOCK)}`,
				`names a blocker: ${firstBlockerLine(text) !== undefined}`,
				`first blocker: ${firstBlockerLine(text) ?? "(none)"}`,
				`the command ran: ${text.includes(RAN_MARKER)}`,
			].join("\n");
		const actual = `${[
			"=== turn 1: the context message the model reads on its next turn ===",
			facts("what the model read at turn end", banner),
			"",
			"=== turn 1: the commit's tool result ===",
			facts("the commit's tool result", blocked.text),
			"",
			"=== turn 2: the commit's tool result after the fix ===",
			facts("the commit's tool result", allowed.text),
		].join("\n")}\n`;
		if (process.env.PI_LENS_WITNESS_UPDATE === "1") {
			fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
			fs.writeFileSync(GOLDEN, actual);
		}
		expect(actual).toBe(fs.readFileSync(GOLDEN, "utf8"));

		// The two surfaces agree: the banner the model read at turn end and the
		// gate's answer name the same blockers, and the tool's own side effects
		// settle what ran.
		expect(banner).toContain("Unresolved from this turn");
		expect(banner).toContain("Debugger statement");
		expect(blocked.text).toContain(GATE_BLOCK);
		expect(blocked.text).toContain("Debugger statement");
		// A blocked call never reached the shell.
		expect(blocked.isError).toBe(true);
		expect(blocked.text).not.toContain(RAN_MARKER);
		// The fixed file has no blocker left, so the gate allows the call and the
		// command really ran.
		expect(allowed.text).not.toContain(GATE_BLOCK);
		expect(allowed.text).toContain(RAN_MARKER);
		expect(handle.errors).toEqual([]);
	});

	it("does not allow the commit after an external change to the recorded bytes", async () => {
		const { proj, target } = seed("gate-external", CLEAN_FILE);
		const handle = await open(proj, [
			step(readTarget(target), "reading"),
			step(writeTarget(target, BLOCKING_FILE), "writing"),
			endTurn("turn 1 done"),
			step(commitAttempt(), "committing"),
			endTurn("turn 2 done"),
		]);

		await handle.prompt("write the file");
		// A formatter, a checkout or an editor wrote the file: no dispatch ran,
		// so nothing re-analysed these bytes, and the record still describes the
		// bytes before them.
		fs.writeFileSync(target, `${BLOCKING_FILE}// external writer\n`);
		await handle.prompt("commit it");

		const [verdict] = bashResults(handle.requests);
		expect(verdict.text).toContain(GATE_BLOCK);
		expect(verdict.isError).toBe(true);
		expect(verdict.text).not.toContain(RAN_MARKER);
		expect(handle.errors).toEqual([]);
	});
});

describe("#4632 s4: a record written in one session answers the next one", () => {
	for (const reason of ["new", "resume", "fork", "reload"] as const) {
		for (const order of ["gate-first", "turn-end-first"] as const) {
			it(`refuses the commit of a ${reason} replacement (${order})`, async () => {
				const name = `replace-${reason}-${order}`;
				const { proj, target } = seed(name, CLEAN_FILE);
				const first = await open(proj, [
					step(readTarget(target), "reading"),
					step(writeTarget(target, BLOCKING_FILE), "writing"),
					// `gate-first` asks the gate in the same turn as the write;
					// `turn-end-first` lets the turn end record the blocker first.
					...(order === "gate-first"
						? [step(commitAttempt(), "committing")]
						: []),
					endTurn("turn 1 done"),
				]);

				await first.prompt("write the file");
				const turnOneBanner = lastInjection(first.requests.at(-1) ?? []);
				if (order === "gate-first") {
					// The control: in the session that raised the blocker, the gate
					// answers on the blocker itself.
					const [here] = bashResults(first.requests);
					expect(here.text).toContain(GATE_BLOCK);
					expect(here.text).toContain("Debugger statement");
					expect(here.isError).toBe(true);
					expect(here.text).not.toContain(RAN_MARKER);
				}

				const second = await first.restart(reason, [
					step(commitAttempt(), "committing again"),
					endTurn("done"),
				]);
				await second.prompt("commit it");

				const [verdict] = bashResults(second.requests);
				// The gate refused the commit in a conversation that did not record
				// the blocker: `session_mismatch` for the record is one answer, and a
				// restored pending blocker is the other. MEASURED, not assumed: at
				// this head both orders answer with the blocker a restored record
				// still owes, so the assertion is the refusal that must hold either
				// way — never "allowed", and never executed.
				expect(verdict.text).toContain(GATE_BLOCK);
				// The RECORD's own refusal, not the live latch's: a replacement whose
				// start ran in full has no in-memory blockers, so the answer can only
				// come from re-judging the previous session's record — the session id
				// that wrote it, or the record's provenance when it names none.
				expect(verdict.text).toMatch(
					/session_mismatch|blocking_provenance_untrusted/,
				);
				// The tool never ran: the marker the shell would print is absent,
				// and pi marked the call an error.
				expect(verdict.text).not.toContain(RAN_MARKER);
				expect(verdict.isError).toBe(true);
				expect(second.errors).toEqual([]);
				if (order === "turn-end-first") {
					// The surface the agent was shown at turn end named the blocker, and
					// the conversation that did not record it is refused: the two
					// surfaces agree that this commit must not proceed.
					expect(turnOneBanner).toContain("Unresolved from this turn");
					expect(turnOneBanner).toContain("Debugger statement");
				}
			});
		}
	}
});
