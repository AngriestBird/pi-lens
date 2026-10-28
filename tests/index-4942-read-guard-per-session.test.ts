/**
 * #4942: a read belongs to the session whose tool call made it.
 *
 * The defect: two sessions in one pi process (an in-process subagent, #473)
 * share the module-scope `RuntimeCoordinator`, whose read guard carried one
 * set of read records. A sibling session's read of a file licensed an edit by
 * a session that never read it, so the guard failed open: the census probe
 * (2026-10-28) read `editWithoutRead false` for the editor, against the
 * single-session control's "Edit without read".
 *
 * Tier 2 (#4632): the BUILT extension in real pi `AgentSession`s, the model
 * scripted at the provider boundary. The second session starts while the
 * first is live, so `session_start` classifies it a concurrent secondary
 * (#4704). Both sessions work in ONE project: the shape a cwd filter cannot
 * separate. Each read is the session's own tool call; nothing is seeded into
 * a store.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CLEAN_FILE,
	endTurn,
	readTarget,
	step,
	toolResults,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	type PiSession,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Two real pi sessions; the other two-session files budget 60 s. */
const TWO_SESSION_TIMEOUT_MS = 60_000;

/** The read guard's refusal, as the edit tool result carries it. */
const EDIT_WITHOUT_READ = "Edit without read";

const SHARED_BEFORE = "return 1;";
const SHARED_AFTER = "return 2;";

function project(name: string): { proj: string; shared: string } {
	const proj = path.join(fixture.root, name, "proj");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.writeFileSync(path.join(proj, "src", "seed.ts"), CLEAN_FILE);
	const shared = path.join(proj, "src", "shared.ts");
	fs.writeFileSync(
		shared,
		`export function shared() {\n\t${SHARED_BEFORE}\n}\n`,
	);
	return { proj, shared };
}

function editShared(shared: string): Record<string, unknown> {
	return fauxToolCall("edit", {
		path: shared,
		edits: [{ oldText: SHARED_BEFORE, newText: SHARED_AFTER }],
	});
}

/** The reading session's script: read the file, close the turn. */
function readTurn(shared: string): PiFauxReply[] {
	return [step(readTarget(shared), "reading"), endTurn("read")];
}

/** The editing session's script: edit the file, close the turn. */
function editTurn(shared: string): PiFauxReply[] {
	return [step(editShared(shared), "editing"), endTurn("edited")];
}

/** What the edit tool told the model in the session's last request. */
function editResult(handle: PiSession): string {
	const last = handle.requests.at(-1) ?? [];
	return toolResults(last, "edit")[0]?.text ?? "";
}

/** Start the primary, then a secondary beside it in the same project. */
async function pair(
	proj: string,
	primaryScript: readonly PiFauxReply[],
	secondaryScript: readonly PiFauxReply[],
): Promise<{ primary: PiSession; secondary: PiSession }> {
	const primary = await startPiSession({
		root: fixture.root,
		cwd: proj,
		responses: primaryScript,
	});
	const secondary = await startPiSession({
		root: fixture.root,
		cwd: proj,
		responses: secondaryScript,
	});
	expect(secondary.session.sessionManager.getSessionId()).not.toBe(
		primary.session.sessionManager.getSessionId(),
	);
	return { primary, secondary };
}

describe("#4942: an edit is licensed only by a read in the editing session", () => {
	it(
		"refuses the secondary's edit of a file only the primary read",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4942, the sub-agent half. The primary's read
			// licensed the subagent's blind edit (census 2026-10-28, C5).
			const { proj, shared } = project("sec-edits");
			const { primary, secondary } = await pair(
				proj,
				readTurn(shared),
				editTurn(shared),
			);
			await primary.prompt("read it");
			await secondary.prompt("edit it");
			expect(editResult(secondary)).toContain(EDIT_WITHOUT_READ);
			expect(fs.readFileSync(shared, "utf8")).toContain(SHARED_BEFORE);
			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"refuses the primary's edit of a file only the secondary read",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4942, the census's own probe shape (C5
			// `withSiblingRead`): the sibling's read licensed the primary.
			const { proj, shared } = project("pri-edits");
			const { primary, secondary } = await pair(
				proj,
				editTurn(shared),
				readTurn(shared),
			);
			await secondary.prompt("read it");
			await primary.prompt("edit it");
			expect(editResult(primary)).toContain(EDIT_WITHOUT_READ);
			expect(fs.readFileSync(shared, "utf8")).toContain(SHARED_BEFORE);
			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"refuses the primary's edit when the secondary read the symbol",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4942 through the other read writer. `read_symbol`
			// records its coverage from a tool with no `tool_call` of its own, so
			// the owner had to come from the call's ctx.
			const { proj, shared } = project("sym-read");
			const { primary, secondary } = await pair(proj, editTurn(shared), [
				step(
					fauxToolCall("read_symbol", { path: shared, symbol: "shared" }),
					"reading a symbol",
				),
				endTurn("read"),
			]);
			await secondary.prompt("read the symbol");
			const symbol = toolResults(
				secondary.requests.at(-1) ?? [],
				"read_symbol",
			);
			expect(symbol[0]?.text ?? "").toContain("function shared");
			await primary.prompt("edit it");
			expect(editResult(primary)).toContain(EDIT_WITHOUT_READ);
			expect(fs.readFileSync(shared, "utf8")).toContain(SHARED_BEFORE);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"lets each session edit the file it read itself",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// The control: partitioning must not take a session's own read away.
			// Both sessions read, then each edits in its own turn; the second edit
			// finds the first's bytes, so it replaces the new text.
			const { proj, shared } = project("own-reads");
			const { primary, secondary } = await pair(
				proj,
				[
					step(readTarget(shared), "reading"),
					step(editShared(shared), "editing"),
					endTurn("edited"),
				],
				[step(readTarget(shared), "reading"), endTurn("read")],
			);
			await secondary.prompt("read it");
			await primary.prompt("read and edit it");
			expect(editResult(primary)).not.toContain(EDIT_WITHOUT_READ);
			expect(fs.readFileSync(shared, "utf8")).toContain(SHARED_AFTER);
			expect(primary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"lets the secondary edit the file it read itself",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			const { proj, shared } = project("own-secondary");
			const { primary, secondary } = await pair(proj, readTurn(shared), [
				step(readTarget(shared), "reading"),
				step(editShared(shared), "editing"),
				endTurn("edited"),
			]);
			await primary.prompt("read it");
			await secondary.prompt("read and edit it");
			expect(editResult(secondary)).not.toContain(EDIT_WITHOUT_READ);
			expect(fs.readFileSync(shared, "utf8")).toContain(SHARED_AFTER);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"refuses the primary's edit of a file only the secondary wrote by bash",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4942's authorship half. A recognized bash write
			// credits its session with authorship (the license to edit what it
			// wrote), stamped through the coordinator's guard, so the subagent's
			// `printf > file` licensed the primary's blind edit.
			const { proj, shared } = project("bash-author");
			const { primary, secondary } = await pair(proj, editTurn(shared), [
				step(
					fauxToolCall("bash", {
						command: `printf '%s\\n' 'export function shared() {' '  return 1;' '}' > src/shared.ts`,
					}),
					"writing by bash",
				),
				endTurn("written"),
			]);
			await secondary.prompt("write it by bash");
			expect(fs.readFileSync(shared, "utf8")).toContain("  return 1;");
			await primary.prompt("edit it");
			expect(editResult(primary)).toContain(EDIT_WITHOUT_READ);
			expect(fs.readFileSync(shared, "utf8")).toContain("return 1;");
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"arms /lens-allow-edit for the invoking session only",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4942's command writer. The one-time exemption
			// is a license like a read: armed through the coordinator's guard it
			// would let the subagent spend the primary user's override.
			const { proj, shared } = project("allow-edit");
			const { primary, secondary } = await pair(
				proj,
				editTurn(shared),
				editTurn(shared),
			);
			await primary.prompt(`/lens-allow-edit ${shared}`);
			await secondary.prompt("edit it");
			expect(editResult(secondary)).toContain(EDIT_WITHOUT_READ);
			expect(fs.readFileSync(shared, "utf8")).toContain(SHARED_BEFORE);
			await primary.prompt("edit it");
			expect(editResult(primary)).not.toContain(EDIT_WITHOUT_READ);
			expect(fs.readFileSync(shared, "utf8")).toContain(SHARED_AFTER);
			expect(primary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);
});
