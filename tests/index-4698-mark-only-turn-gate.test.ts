/**
 * #4698: a turn whose ONLY action is `lens_diagnostic_mark` must clear the
 * `--lens-guard` commit gate for the blocker it marked.
 *
 * The defect: turn end re-derives the commit-gate latch from the turn-end
 * disposition policy (`resyncGitGuardAfterInlinePolicy`, #3248) at the point
 * where a file's post-policy survivor set is final. A turn that writes no file
 * returns from `handleTurnEnd` long before that pass (`clients/runtime-turn.ts`,
 * the `files.length === 0` early return), so the mark took and the next prompt
 * showed no blocker, while the latch still counted the marked record and
 * `--lens-guard` named it back at the commit. Two surfaces judged one
 * disposition, and only one of them saw the mark.
 *
 * Tier 2 (#4632): the BUILT extension inside a real pi `AgentSession`, with the
 * host's own `fauxProvider` scripted at the provider boundary. Nothing here is
 * mocked — the blocker is a bundled rule's answer on a real file, the mark is
 * the real `lens_diagnostic_mark` tool, and the commit is a real `bash` call
 * whose gate answer is asserted from the tool result the MODEL received. The
 * helper shape (one tool call per reply, the `echo` marker, the
 * `lens_diagnostic_mark` identity) follows
 * `tests/index-4632-s4-tool-call-verdict.test.ts`, which cannot be imported:
 * its helpers are module-local and it is a test file of its own.
 *
 * The commit verb carries a marker (`echo`) after a `;`: a blocked call never
 * reaches the shell, so the marker's ABSENCE is the observable that the tool
 * did not execute and its presence is the observable that it did. That keeps
 * the assertion true whether git refuses the commit or creates one, so the
 * case does not depend on the checkout it runs in.
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
 * language server's.
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

const CLEAN_FILE = "const a = 1;\nexport function f() {\n\treturn a;\n}\n";

/**
 * The blocker both cases raise, and the one the first case marks. The bundled
 * tree-sitter rule `ts-weak-hash` has no biome, oxlint or ast-grep twin for
 * TypeScript, so exactly one runner reports it and one mark covers the file
 * (`lens_diagnostic_mark` must name EVERY blocker on a file to suppress it).
 */
const MARKED_FILE =
	'import * as crypto from "node:crypto";\nexport function digest(text: string): string {\n\treturn crypto.createHash("md5").update(text).digest("hex");\n}\n';
const BLOCKER = {
	line: 3,
	message:
		"Weak hash primitive selected (md5/sha1) — use sha256+ for security-sensitive contexts",
	rule: "ts-weak-hash",
	tool: "tree-sitter",
} as const;

/** The commit gate's own prefix, as the model reads it. */
const GATE_BLOCK = "🔴 COMMIT BLOCKED (--lens-guard)";
/** Printed by the shell only when the guarded command actually ran. */
const RAN_MARKER = "PI-LENS-GUARDED-COMMAND-RAN";

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

/** The model's own triage, with the blocker's reported identity. */
function markFalsePositive(target: string): Record<string, unknown> {
	return fauxToolCall("lens_diagnostic_mark", {
		filePath: target,
		...BLOCKER,
		disposition: "false-positive",
	});
}

/** `lens_diagnostic_mark` is situational: callable only after activation. */
function activateMarkTool(): Record<string, unknown> {
	return fauxToolCall("pi_lens_activate_tools", {
		tools: ["lens_diagnostic_mark"],
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
 * Every result of one tool in one transcript, in order. Read from the LAST
 * transcript only: each provider request carries the whole conversation, so
 * folding every request would count one result once per later round trip.
 */
function toolResults(
	transcript: readonly PiMessage[],
	toolName: string,
): Received[] {
	return transcript
		.filter(
			(message) =>
				message.role === "toolResult" && message.toolName === toolName,
		)
		.map(received);
}

/** A file written before the session starts, in a project of its own. */
function seed(name: string, content: string): { proj: string; target: string } {
	const proj = path.join(fixture.root, name, "proj");
	const target = path.join(proj, "src", "target.ts");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return { proj, target };
}

/** Raise the blocker, and let the turn end record it. */
function raise(target: string): PiFauxReply[] {
	return [
		step(readTarget(target), "reading"),
		step(writeTarget(target, MARKED_FILE), "writing"),
		endTurn("turn 1 done"),
	];
}

/** Turn 2 of both cases: a turn that writes no file at all. */
function noWriteTurn(...calls: Record<string, unknown>[]): PiFauxReply[] {
	return [...calls.map((call) => step(call)), endTurn("turn 2 done")];
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

describe("#4698: a mark-only turn clears the commit gate it marked", () => {
	it("lets the commit through on the turn AFTER a mark that wrote no file", async () => {
		const { proj, target } = seed("mark-only", CLEAN_FILE);
		const handle = await open(proj, [
			...raise(target),
			// Turn 2: the model's whole action is the mark. Nothing is written,
			// so this is the turn shape that used to return before the policy pass.
			...noWriteTurn(activateMarkTool(), markFalsePositive(target)),
			// Turn 3: the commit the mark should now unblock.
			step(commitAttempt(), "committing"),
			endTurn("turn 3 done"),
		]);
		await handle.prompt("write the file");
		await handle.prompt("mark the blocker false-positive");
		await handle.prompt("commit it");

		const [marked] = toolResults(
			handle.requests.at(-1) ?? [],
			"lens_diagnostic_mark",
		);
		const [commit] = toolResults(handle.requests.at(-1) ?? [], "bash");
		// The mark itself was accepted, so a later failure is the gate's, not the
		// mark's.
		expect(marked?.isError).toBe(false);
		expect(marked?.text).toContain("marked false-positive");
		// The gate the model reads: allowed, and the command really ran.
		expect(commit?.text).not.toContain(GATE_BLOCK);
		expect(commit?.text).toContain(RAN_MARKER);
		expect(handle.errors).toEqual([]);
	});

	it("still refuses the commit when a no-write turn marks nothing", async () => {
		// The other direction of the same rule, so the fix cannot become "a turn
		// that wrote no file opens the gate": the record's blocker is still
		// unmarked, the bytes it describes are still on disk, and the gate must
		// keep refusing.
		const { proj, target } = seed("mark-only-control", CLEAN_FILE);
		const handle = await open(proj, [
			...raise(target),
			// Turn 2: a read-only turn that marks nothing.
			...noWriteTurn(readTarget(target)),
			step(commitAttempt(), "committing"),
			endTurn("turn 3 done"),
		]);
		await handle.prompt("write the file");
		await handle.prompt("re-read the file");
		await handle.prompt("commit it");

		const [commit] = toolResults(handle.requests.at(-1) ?? [], "bash");
		expect(commit?.text).toContain(GATE_BLOCK);
		// The latch's own list, naming the blocker the turn never marked.
		expect(commit?.text).toContain(BLOCKER.message);
		expect(commit?.text).not.toContain(RAN_MARKER);
		expect(commit?.isError).toBe(true);
		expect(handle.errors).toEqual([]);
	});
});
