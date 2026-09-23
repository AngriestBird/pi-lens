/**
 * #3248 witness (ADR 0007) — the git-guard COMMIT GATE through the pi HOST
 * entry, under `--lens-guard`.
 *
 * The slice's claim is a two-surface agreement: what the agent is shown at
 * turn end, and what `git commit` is told a moment later. Both are committed
 * here as one golden artifact
 * (`tests/fixtures/witness/git-guard-latch/all-marked-commit-allowed.txt`)
 * produced by `index.ts`'s own registered `session_start` / `turn_start` /
 * `tool_result` / `turn_end` / `context` handlers plus the real
 * `evaluateGitGuard` the pre-commit path calls, so a future change that
 * silences one surface without the other shows up as a diff.
 *
 * What the golden shows, and what it does NOT: turn 2's commit attempt is
 * still blocked — with `blocking_provenance_untrusted`, NOT with the latch's
 * "unresolved blockers must be fixed" and the marked findings quoted back.
 * That second reason is #3282, a pre-existing defect in the persisted record's
 * provenance parse that this slice does not own (measured on `origin/master`
 * in that issue, with the blocker FIXED rather than marked, so it is
 * independent of dispositions). The golden pins both halves on purpose: the
 * latch defect is gone, and the exact fingerprint of what still blocks is
 * committed, so #3282's fix flips this file visibly instead of silently.
 *
 * Doubles: `clients/pipeline.js` only — a true process boundary (it spawns
 * every configured linter). Its result is shaped exactly as `pipeline.ts`
 * shapes it: `inlineBlockerSummary` is `formatDiagnostics(blockers,
 * "blocking").trim()`, the same expression `dispatcher.ts` renders
 * `blockerOutput` with, from the same array handed to
 * `inlineBlockerDiagnostics` — so the double cannot make the fix look green by
 * disagreeing with itself. `handleToolResult`, `handleTurnEnd`, the
 * `RuntimeCoordinator`, the `CacheManager`, the durable disposition store,
 * `syncGitGuardRecord` and `evaluateGitGuard` are REAL.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipeline = vi.hoisted(() => ({ runPipeline: vi.fn() }));
vi.mock("../clients/pipeline.js", () => pipeline);

import { markDisposition } from "../clients/diagnostic-dispositions.js";
import type { Diagnostic } from "../clients/dispatch/types.js";
import { formatDiagnostics } from "../clients/dispatch/utils/format-utils.js";
import extension from "../index.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

const SESSION_ID = "pi-3248-git-guard-latch-session";

const GOLDEN = path.join(
	import.meta.dirname,
	"fixtures/witness/git-guard-latch/all-marked-commit-allowed.txt",
);

let tmpDir: string;

beforeEach(() => {
	pipeline.runPipeline.mockReset();
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3248-witness-")),
	);
});

afterEach(() => removeTempDirSync(tmpDir));

function blockingDiagnostic(
	filePath: string,
	line: number,
	message: string,
): Diagnostic {
	return {
		id: `ast-grep:${path.basename(filePath)}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool: "ast-grep",
		rule: "no-eval",
	};
}

/** The `PipelineResult` the real pipeline builds for a blocking run. */
function blockingPipelineResult(blockers: Diagnostic[]) {
	const summary = formatDiagnostics(blockers, "blocking").trim();
	return {
		output: summary,
		hasBlockers: true,
		isError: false,
		fileModified: false,
		inlineBlockerSummary: summary,
		inlineBlockerSources: ["ast-grep"],
		inlineBlockerLines: blockers.map((d) => d.line),
		inlineBlockerDiagnostics: blockers,
	};
}

const CLEAN_PIPELINE_RESULT = {
	output: "",
	hasBlockers: false,
	isError: false,
	fileModified: false,
};

describe("#3248 witness: the commit gate and the banner agree through pi", () => {
	it("matches the committed golden for a fully marked file", async () => {
		const filePath = path.join(tmpDir, "src", "app.ts");
		const unrelated = path.join(tmpDir, "notes.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "alpha();\nbeta();\n");
		fs.writeFileSync(unrelated, "export const note = 1;\n");
		const blockers = [
			blockingDiagnostic(filePath, 1, "alpha is unsafe"),
			blockingDiagnostic(filePath, 2, "beta is unsafe"),
		];
		const blocking = blockingPipelineResult(blockers);
		pipeline.runPipeline.mockImplementation(
			async (ctx: { filePath: string }) =>
				path.resolve(ctx.filePath) === path.resolve(filePath)
					? blocking
					: CLEAN_PIPELINE_RESULT,
		);

		const pi = createPiMock();
		pi.setFlag("lens-guard", true);
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tmpDir, sessionId: SESSION_ID }),
		);

		/** The real commit gate: pi-lens's `tool_call` hook on a bash commit. */
		const commitAttempt = async () =>
			((await pi.emit(
				"tool_call",
				{ toolName: "bash", input: { command: 'git commit -m "wip"' } },
				makeCtx({ cwd: tmpDir }),
			)) ?? {}) as { block?: boolean; reason?: string };

		const editTurnStart = async () =>
			await pi.emit("turn_start", {}, makeCtx({ cwd: tmpDir }));
		const edit = async (file: string) =>
			await pi.emit(
				"tool_result",
				{
					toolName: "edit",
					input: { path: file },
					details: { diff: "+  1 alpha();" },
					content: [{ type: "text", text: "base" }],
				},
				makeCtx({ cwd: tmpDir }),
			);
		const endTurn = async () => {
			await pi.emit("turn_end", {}, makeCtx({ cwd: tmpDir }));
			const injected = (await pi.emit(
				"context",
				{ messages: [{ role: "user", content: "keep working" }] },
				makeCtx({ cwd: tmpDir }),
			)) as { messages?: Array<{ content: string }> } | undefined;
			return (
				(injected?.messages ?? [])
					.map((m) => m.content)
					.join("\n\n")
					.replaceAll(tmpDir, "<PROJECT>")
					.trimEnd() || "(nothing injected)"
			);
		};

		// Turn 1: the edit raises two blockers, they are delivered, the gate
		// closes on them.
		await editTurnStart();
		await edit(filePath);
		const turn1 = await endTurn();
		const turn1Commit = await commitAttempt();

		// Turn 2, the reported shape: the agent edits the same file again, judges
		// both findings false-positive through `lens_diagnostic_mark`, and the
		// turn ends. Nothing is delivered — and the commit gate must agree.
		await editTurnStart();
		await edit(filePath);
		for (const blocker of blockers) {
			markDisposition(
				tmpDir,
				{
					cwd: tmpDir,
					filePath,
					tool: "ast-grep",
					rule: "no-eval",
					message: blocker.message,
					line: blocker.line,
					content: fs.readFileSync(filePath, "utf8"),
				},
				"false-positive",
			);
		}
		const turn2 = await endTurn();
		const turn2Commit = await commitAttempt();

		// Turn 3: a turn that touches only an unrelated file. The marked blockers
		// must not come back — on either surface.
		await editTurnStart();
		await edit(unrelated);
		const turn3 = await endTurn();
		const turn3Commit = await commitAttempt();

		const verdict = (result: { block?: boolean; reason?: string }) =>
			[
				`block: ${result.block ?? false}`,
				`reason: ${(result.reason ?? "(none)").replaceAll(tmpDir, "<PROJECT>")}`,
			].join("\n");

		const actual = `${[
			"=== turn 1 (blockers raised): context message ===",
			turn1,
			"--- turn 1: git commit ---",
			verdict(turn1Commit),
			"",
			"=== turn 2 (every blocker marked false-positive): context message ===",
			turn2,
			"--- turn 2: git commit (residual block is #3282, not the latch) ---",
			verdict(turn2Commit),
			"",
			"=== turn 3 (an unrelated file edited): context message ===",
			turn3,
			"--- turn 3: git commit (residual block is #3282, not the latch) ---",
			verdict(turn3Commit),
		].join("\n")}\n`;

		if (process.env.PI_LENS_WITNESS_UPDATE === "1") {
			fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
			fs.writeFileSync(GOLDEN, actual);
		}
		expect(actual).toBe(fs.readFileSync(GOLDEN, "utf-8"));
	});
});
