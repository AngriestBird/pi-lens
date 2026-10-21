/**
 * #4689: one file reached through two spellings is one file, as the MODEL
 * sees it.
 *
 * The defect: the POSIX path key kept the link spelling while the license
 * check, the opaque-write recovery and the class seam used the kernel-real
 * path, so a symlinked file had one record per spelling. The model saw it as
 * a refused edit of a file it had just read (the read guard), a "clean"
 * verdict for a bash write that the real path reports as STOP (attribution),
 * and a stale blocker under the link after a fix through the target (the
 * widget store, which keys by spelling: a later #4689 slice). Each cell drives pi's real read, edit, write and bash tools
 * through a real `AgentSession` (`tests/support/pi-session.ts`) and asserts
 * the tool result the model received, so the identity rule is pinned at the
 * surface that broke rather than at the key function alone (that half is
 * `tests/clients/path-utils.test.ts`, "path identity").
 *
 * Every cell builds its own project from `createPathIdentityFixture`, under
 * this file's one fixture root, so no case reads another's state. Lane:
 * ubuntu Unit tests; a host that cannot create symlinks skips visibly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BLOCKING_FILE,
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	type Received,
	commitAttempt,
	endTurn,
	readTarget,
	step,
	toolResults,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";
import {
	type PathIdentityFixture,
	createPathIdentityFixture,
} from "./clients/test-utils.js";

const fixture = piSessionFixture();

/** The read guard's refusal, as the edit tool result carries it. */
const EDIT_WITHOUT_READ = "Edit without read";

function family(name: string): PathIdentityFixture {
	const base = path.join(fixture.root, name);
	fs.mkdirSync(base, { recursive: true });
	return createPathIdentityFixture(base);
}

async function run(
	fx: PathIdentityFixture,
	responses: readonly PiFauxReply[],
	flags?: ReadonlyMap<string, boolean>,
): Promise<{ results: readonly Received[][] }> {
	const handle = await startPiSession({
		root: fixture.root,
		cwd: fx.repo,
		responses,
		...(flags ? { flags } : {}),
	});
	await handle.prompt("go");
	const last = handle.requests.at(-1) ?? [];
	const results = [toolResults(last, "edit"), toolResults(last, "bash")];
	await handle.dispose();
	return { results };
}

function editCall(target: string, oldText: string, newText: string) {
	return fauxToolCall("edit", {
		path: target,
		edits: [{ oldText, newText }],
	});
}

describe("#4689: the read guard credits a read under any spelling of the file", () => {
	// RECURRENCE GUARDED: the read credit (`ReadGuard.key`) kept the spelling
	// while the license (`licenseKey`) took the realpath, so a file read through
	// a link and edited through its target (or the reverse, for a file and a
	// directory link) was refused as never read: 4 of 4 cells in the #4689
	// audit (probe 2.3).
	const cells: Array<
		[
			string,
			(fx: PathIdentityFixture) => {
				read: string;
				edit: string;
				target: string;
				before: string;
			},
		]
	> = [
		[
			"read the file link, edit its target",
			(fx) => ({
				read: fx.fileLink,
				edit: fx.realFile,
				target: fx.realFile,
				before: "export const real = 1;",
			}),
		],
		[
			"read the target, edit the file link",
			(fx) => ({
				read: fx.realFile,
				edit: fx.fileLink,
				target: fx.realFile,
				before: "export const real = 1;",
			}),
		],
		[
			"read through the dir link, edit the real file",
			(fx) => ({
				read: fx.dirLinkFile,
				edit: fx.sharedFile,
				target: fx.sharedFile,
				before: "export const util = 1;",
			}),
		],
		[
			"read the real file, edit through the dir link",
			(fx) => ({
				read: fx.sharedFile,
				edit: fx.dirLinkFile,
				target: fx.sharedFile,
				before: "export const util = 1;",
			}),
		],
		[
			"read and edit the same spelling (control)",
			(fx) => ({
				read: fx.realFile,
				edit: fx.realFile,
				target: fx.realFile,
				before: "export const real = 1;",
			}),
		],
	];

	for (const [index, [name, pick]] of cells.entries()) {
		it(`${name}: the edit lands`, async (ctx) => {
			const fx = family(`read-cell-${index}`);
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const cell = pick(fx);
			const after = cell.before.replace("1;", "2;");
			const {
				results: [edits],
			} = await run(fx, [
				step(readTarget(cell.read), "reading"),
				step(editCall(cell.edit, cell.before, after), "editing"),
				endTurn(),
			]);
			expect(edits?.[0]?.text ?? "").not.toContain(EDIT_WITHOUT_READ);
			expect(fs.readFileSync(cell.target, "utf8")).toContain(after);
		});
	}

	it("a file nobody read is still refused under its link spelling", async (ctx) => {
		const fx = family("read-unread");
		if (fx.skipReason) return ctx.skip(fx.skipReason);
		const {
			results: [edits],
		} = await run(fx, [
			step(
				editCall(
					fx.fileLink,
					"export const real = 1;",
					"export const real = 2;",
				),
				"editing",
			),
			endTurn(),
		]);
		expect(edits?.[0]?.text ?? "").toContain(EDIT_WITHOUT_READ);
		expect(fs.readFileSync(fx.realFile, "utf8")).toContain(
			"export const real = 1;",
		);
	});
});

/** A bash write of the blocking file, one shell line per source line. */
function bashWrite(relativeTarget: string): Record<string, unknown> {
	const lines = BLOCKING_FILE.replace(/\n$/, "")
		.split("\n")
		.map((line) => `'${line.replace(/\t/g, "  ")}'`)
		.join(" ");
	return fauxToolCall("bash", {
		command: `printf '%s\\n' ${lines} > ${relativeTarget}`,
	});
}

describe("#4689: a bash write through a link reports what the real path reports", () => {
	// RECURRENCE GUARDED: the recognized redirect target kept the link
	// spelling while the opaque recovery reported the realpath, so the
	// subtraction between them never matched and the write was attributed to
	// nobody: the model read "clean" for a file holding a blocker (#4689 audit,
	// probe 2.4). The real-path write is the control.
	for (const [name, relativeTarget] of [
		["through the file link", "src/link.ts"],
		["through the real path (control)", "src/real.ts"],
	] as const) {
		it(`${name}: the bash result names the blocker and the commit gate holds it`, async (ctx) => {
			const fx = family(`bash-${relativeTarget.replace(/\W/g, "-")}`);
			if (fx.skipReason) return ctx.skip(fx.skipReason);
			const {
				results: [, bash],
			} = await run(
				fx,
				[
					step(readTarget(fx.realFile), "reading"),
					step(bashWrite(relativeTarget), "writing"),
					step(commitAttempt(), "committing"),
					endTurn(),
				],
				new Map(GUARDED_FLAGS),
			);
			// STOP is rendered only when the pipeline keeps autonomous writers
			// (`hasBlockers` is `allowAutonomousWriters && …` in
			// clients/pipeline.ts), so it also shows the write's authorship
			// matched: a mismatch degrades to "clean".
			const write = bash?.[0]?.text ?? "";
			expect(write).toContain("STOP");
			expect(write).not.toContain("clean");
			// The blocker is recorded where the next gate reads it: the commit
			// that follows is refused and never runs.
			const commit = bash?.[1];
			expect(commit?.text).toContain(GATE_BLOCK);
			expect(commit?.text).not.toContain(RAN_MARKER);
		});
	}
});
