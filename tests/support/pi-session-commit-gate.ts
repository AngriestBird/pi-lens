/**
 * Turn scripts and transcript readers shared by the tier-2 commit-gate cases
 * (`#4632 s4`'s `tool_call` verdict, `#4698`'s mark-only turn), #4701 F2.
 *
 * Both files drive the BUILT extension inside a real pi `AgentSession` through
 * `./pi-session.js` and script the model at the provider boundary; the pieces
 * below are the same in both — the guarded verb with its shell marker, the
 * blocking files and their reported identities, the one-tool-call-per-reply
 * step, and the readers that recover what the MODEL received. They lived twice,
 * 105 lines byte-identical after whitespace folding, which is the shape the
 * net-count rule exists for. Nothing here asserts anything: it is test input
 * and transcript access, and the file that imports it owns every expectation.
 *
 * Two things stay in the calling file because they differ: the blocking file a
 * case raises (each file names its own — `debugger;` for the tool-call verdict,
 * a weak hash for the mark-only turn) and the per-case turn grouping
 * (`noWriteTurn`, `raiseThenMark`, `commitThenEnd`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type PiFauxReply,
	type PiMessage,
	type PiSession,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	startPiSession,
} from "./pi-session.js";

/**
 * The flag set these cases run with: the helper's defaults plus the commit
 * gate. LSP is off because the blockers under test are bundled rules', not a
 * language server's.
 */
export const GUARDED_FLAGS: ReadonlyArray<[string, boolean]> = [
	["lens-guard", true],
	["no-lsp", true],
	["no-autofix", true],
	["no-autoformat", true],
	["no-tests", true],
	["no-opengrep", true],
	["no-delta", true],
	["no-complexity", true],
];

/** A file whose bundled rules raise nothing. */
export const CLEAN_FILE =
	"const a = 1;\nexport function f() {\n\treturn a;\n}\n";

/**
 * The file whose bundled `ts-weak-hash` finding is the one a case MARKS. The
 * rule has no biome, oxlint or ast-grep twin for TypeScript, so exactly one
 * runner reports it and one mark covers the file (`lens_diagnostic_mark` must
 * name EVERY blocker on a file to suppress it). Its identity is the one
 * `lens_diagnostics` reports (`[ts-weak-hash]` at L3) and the runner stamps
 * (`clients/dispatch/runners/tree-sitter.ts`, `tool: "tree-sitter"`).
 */
export const MARKED_FILE =
	'import * as crypto from "node:crypto";\nexport function digest(text: string): string {\n\treturn crypto.createHash("md5").update(text).digest("hex");\n}\n';

/**
 * The file `debugger;` sits in: the bundled `debugger-statement` rule
 * (`rules/tree-sitter-queries/typescript/debugger.yml`, `inline_tier:
 * blocking`) always raises it, and in SOME runs biome's `noDebugger` too —
 * measured both ways on one host. A case that raises it asserts a refusal and
 * its first blocker, which hold either way.
 */
export const BLOCKING_FILE =
	"const a = 1;\nexport function f() {\n\tdebugger;\n\treturn a;\n}\n";
export const BLOCKER = {
	line: 3,
	message:
		"Weak hash primitive selected (md5/sha1) — use sha256+ for security-sensitive contexts",
	rule: "ts-weak-hash",
	tool: "tree-sitter",
} as const;

/** The commit gate's own prefix, as the model reads it. */
export const GATE_BLOCK = "🔴 COMMIT BLOCKED (--lens-guard)";
/** Printed by the shell only when the guarded command actually ran. */
export const RAN_MARKER = "PI-LENS-GUARDED-COMMAND-RAN";

/**
 * The commit attempt: the guarded verb, then a marker the shell prints. A
 * blocked call never reaches the shell, so the marker's ABSENCE is the
 * observable that the tool did not execute, and its presence is the observable
 * that it did. The marker keeps that assertion true whether git refuses the
 * commit or creates one, so the case does not depend on the checkout it runs
 * in.
 */
export function commitAttempt(): Record<string, unknown> {
	return fauxToolCall("bash", {
		command: `git commit -m "wip"; echo ${RAN_MARKER}`,
	});
}

export function readTarget(target: string): Record<string, unknown> {
	return fauxToolCall("read", { path: target });
}

export function writeTarget(
	target: string,
	content: string,
): Record<string, unknown> {
	return fauxToolCall("write", { path: target, content });
}

/** The model's own triage: the blocker's reported identity, `false-positive`. */
export function markFalsePositive(target: string): Record<string, unknown> {
	return fauxToolCall("lens_diagnostic_mark", {
		filePath: target,
		...BLOCKER,
		disposition: "false-positive",
	});
}

/** `lens_diagnostic_mark` is situational: callable only after activation. */
export function activateMarkTool(): Record<string, unknown> {
	return fauxToolCall("pi_lens_activate_tools", {
		tools: ["lens_diagnostic_mark"],
	});
}

/** One scripted step: at most ONE tool call, so its result lands first. */
export function step(
	call: Record<string, unknown>,
	note = "working",
): PiFauxReply {
	return fauxAssistantMessage([fauxText(note), call]);
}

/** A turn-closing step: no tool call, so the host emits `turn_end`. */
export function endTurn(note = "done"): PiFauxReply {
	return fauxAssistantMessage(fauxText(note));
}

/** Every text block of one message, in order. */
export function textBlocks(message: PiMessage | undefined): string[] {
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
export interface Received {
	readonly text: string;
	readonly isError: boolean;
}

export function received(message: PiMessage): Received {
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
export function toolResults(
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
export function seed(
	root: string,
	name: string,
	content: string,
): { proj: string; target: string } {
	const proj = path.join(root, name, "proj");
	const target = path.join(proj, "src", "target.ts");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return { proj, target };
}

/** Raise a blocker, and let the turn end record it. */
export function raise(target: string, content = BLOCKING_FILE): PiFauxReply[] {
	return [
		step(readTarget(target), "reading"),
		step(writeTarget(target, content), "writing"),
		endTurn("turn 1 done"),
	];
}

/** Start one guarded session under the file's own fixture root. */
export async function openGuardedSession(
	root: string,
	proj: string,
	responses: readonly PiFauxReply[],
): Promise<PiSession> {
	return startPiSession({
		root,
		cwd: proj,
		flags: new Map(GUARDED_FLAGS),
		responses,
	});
}
