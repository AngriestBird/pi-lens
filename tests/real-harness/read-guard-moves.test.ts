import { describe, expect, it } from "vitest";
import { type RealPi, withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — the read guard's branch admission reads pi's own session branch after a real RPC clone rebinds the extension; the ids a nested call carries (`c1/1`, parent `c1`) and the toolResult pi persists for it exist only in the real host
//
// Recurrence prevented: #4138 (a relative-path read left no record with an
// id, so every /clone, /fork, /tree and /reload dropped it and the next edit
// was refused), #3831 (a nested codemode read was recorded under `c1/1`,
// which is never a toolResult on the branch) and #4185 round 1 F1 (a read
// that errored kept an identity and licensed an edit after the clone) and F4
// (a nested `bash grep` stayed under the nested id).

type Row = Record<string, unknown>;

/**
 * Prompt 1 runs the scenario's first turn, then RPC clone, then the edit.
 * `retained` is the forked session's `read_guard_branch_retained` row; the
 * logger flushes it asynchronously, so callers poll it.
 */
async function readCloneEdit(pi: RealPi): Promise<{
	edit: Row;
	retained: () => Row | undefined;
}> {
	// The run has to end (tool result delivered, second assistant message
	// streamed) before pi accepts the clone and the next prompt.
	await pi.prompt("read");
	await pi.events("agent_end");
	const clone = await pi.clone();
	expect(clone).toMatchObject({ success: true });
	await pi.prompt("edit");
	const edit = await pi.awaitToolResult("edit");
	await pi.events("agent_end");
	const retained = () =>
		pi.lens
			.latencyRows()
			.filter(
				(row) =>
					row.phase === "read_guard_branch_retained" &&
					(row.metadata as Row | undefined)?.trigger === "fork",
			)
			.at(-1)?.metadata as Row | undefined;
	return { edit, retained };
}

const kept = (retained: () => Row | undefined, expected: Row) =>
	expect.poll(retained, { timeout: 5_000 }).toMatchObject(expected);

const applied = {
	isError: false,
	result: {
		content: expect.arrayContaining([
			expect.objectContaining({
				text: expect.stringContaining("Successfully replaced 1 block(s)"),
			}),
		]),
	},
};
const refused = {
	isError: true,
	result: {
		content: expect.arrayContaining([
			expect.objectContaining({
				text: expect.stringContaining("Edit without read"),
			}),
		]),
	},
};

const scenario = (script: string) => ({
	fixture: "read-guard-moves",
	script,
	// The edit's LSP warm and the typescript server are not under test here,
	// and they cost the lane seconds per child.
	args: ["--no-lsp"],
	env: { PI_LENS_TEST_MODE: "0" },
	agentSettings: { defaultTools: ["+codemode"] },
});

describe("real pi RPC: read evidence across a conversation move", () => {
	it("keeps a relative-path top-level read across /clone and applies the next edit (#4138)", async () => {
		await withRealPi(scenario("script.json"), async (pi) => {
			const { edit, retained } = await readCloneEdit(pi);
			await kept(retained, { kept: 1, dropped: 0 });
			expect(edit).toMatchObject(applied);
		});
	}, 60_000);

	it("keeps a nested codemode read under its parent's transcript id across /clone (#3831)", async () => {
		await withRealPi(scenario("nested-read.json"), async (pi) => {
			const { edit, retained } = await readCloneEdit(pi);
			const nested = pi
				.toolResults()
				.find((row) => row.toolName === "read" && row.parentToolCallId);
			expect(nested).toMatchObject({
				toolCallId: "c1/1",
				parentToolCallId: "c1",
			});
			await kept(retained, { kept: 1, dropped: 0 });
			expect(edit).toMatchObject(applied);
		});
	}, 60_000);

	it("keeps a nested bash grep's search read across /clone (#3831)", async () => {
		await withRealPi(scenario("nested-grep.json"), async (pi) => {
			const { edit, retained } = await readCloneEdit(pi);
			await kept(retained, { kept: 1, dropped: 0 });
			expect(edit).toMatchObject(applied);
		});
	}, 60_000);

	it("drops a top-level read that errored, so the edit after /clone is refused", async () => {
		await withRealPi(scenario("failed-read.json"), async (pi) => {
			const { edit, retained } = await readCloneEdit(pi);
			expect(
				pi.toolResults().find((row) => row.toolName === "read"),
			).toMatchObject({ isError: true });
			// The errored result dropped the tool_call capture, so the clone had
			// no read of a.ts to keep or drop.
			await kept(retained, { kept: 0, dropped: 0 });
			expect(edit).toMatchObject(refused);
		});
	}, 60_000);

	it("drops a nested read that errored even though its parent's result is on the branch", async () => {
		await withRealPi(scenario("nested-failed-read.json"), async (pi) => {
			const { edit, retained } = await readCloneEdit(pi);
			expect(
				pi.toolResults().find((row) => row.toolName === "read"),
			).toMatchObject({ isError: true, parentToolCallId: "c1" });
			// The errored result dropped the tool_call capture, so the clone had
			// no read of a.ts to keep or drop.
			await kept(retained, { kept: 0, dropped: 0 });
			expect(edit).toMatchObject(refused);
		});
	}, 60_000);

	// The live twin of round 1 F1, found by the model (`formal/read-guard`
	// FailedReadLive): without any move, the errored read's capture satisfied
	// the zero-read check for the next oldText edit.
	it("refuses an edit after a read that errored, with no move at all", async () => {
		await withRealPi(scenario("failed-read-live.json"), async (pi) => {
			await pi.prompt("read");
			await pi.events("agent_end");
			await pi.prompt("edit");
			const edit = await pi.awaitToolResult("edit");
			await pi.events("agent_end");
			expect(
				pi.toolResults().find((row) => row.toolName === "read"),
			).toMatchObject({ isError: true });
			expect(edit).toMatchObject(refused);
		});
	}, 60_000);
});
