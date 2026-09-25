/**
 * #2939 M8 and W4's call-site half — `index.ts` picks the `tool_result` wall
 * budget and the ledger hook from `isEditClassToolResult(...)` at TWO sites
 * (the inner `bounded(handleToolResult(...))` and the registration wrapper's
 * `budgetKey` callback), and PR #2897's verify measured BOTH green under
 * mutation because every existing test drives `handleToolResult` directly and
 * none drives the registered host handler.
 *
 * Recurrence prevented: #2897 round 1 shipped one 10 s budget for every tool
 * result, so a wedged dependency on a Read held the host twenty times longer
 * than the read-only contract allows (#2523 AC5 — "Read/Grep/Glob/Bash must
 * never await analyzer bootstrap"), and #2939 W4's F3 found the two edit-class
 * copies disagreeing with each other. Both bounds are observed here through
 * the production `hook-await-exceeded` ledger row, whose subject is
 * `<hook>:<label>` and whose reason names the budget that fired.
 *
 * Doubles: the host (`createPiMock`), the analyzer-bootstrap module (the
 * shared production-faithful `bootstrapSeamMock`, because the edit path AWAITS
 * a load that really spawns availability probes), and the TIMING of
 * `handleToolResult` — the real export, wrapped so its promise never settles,
 * which is the wedged dependency these budgets exist for. `bounded` and the
 * degradation ledger are real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `true` makes the real handler's promise never settle (the wedged await). */
const handlerGate = vi.hoisted(() => ({ hang: false }));
vi.mock("../clients/runtime-tool-result.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/runtime-tool-result.js")>();
	return {
		...actual,
		handleToolResult: (deps: Parameters<typeof actual.handleToolResult>[0]) =>
			handlerGate.hang
				? new Promise<never>(() => {})
				: actual.handleToolResult(deps),
	};
});

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		metricsClient: { reset: () => {} },
	}));
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import extension from "../index.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

let tmpDir: string;
let filePath: string;

beforeEach(() => {
	handlerGate.hang = true;
	resetDegradationLedger();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2939-budget-"));
	filePath = path.join(tmpDir, "witnessed.ts");
	fs.writeFileSync(filePath, "const a = 1;\nconst b = 2;\n", "utf8");
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Every `hook-await-exceeded` row, as `<hook>:<label>` → reason. */
function exceeded(): Record<string, string> {
	const rows: Record<string, string> = {};
	for (const entry of getDegradationSummary().find(
		(group) => group.kind === "hook-await-exceeded",
	)?.latestReasons ?? []) {
		rows[entry.subject] = entry.reason;
	}
	return rows;
}

/**
 * Register the real handlers with the clock already fake — every deadline
 * `bounded()` arms has to be a fake timer — and emit one wedged `tool_result`.
 * The returned promise settles only when a bound gives up on it.
 */
function wedgedEmit(event: Record<string, unknown>): Promise<unknown> {
	vi.useFakeTimers();
	const pi = createPiMock();
	extension(pi.asExtensionAPI());
	return pi.emit("tool_result", event, makeCtx({ cwd: tmpDir }));
}

const readEvent = () => ({
	toolName: "read",
	toolCallId: "rd-1",
	input: { path: "PLACEHOLDER" },
	content: [],
});

describe("#2939 M8/W4b — the registration's wall budget follows the edit class", () => {
	it("releases a READ result at the 500ms read-only budget", async () => {
		const event = readEvent();
		event.input.path = filePath;
		const settled = wedgedEmit(event);
		await vi.advanceTimersByTimeAsync(500);
		await settled;

		// The 500 is `HOOK_WALL_BUDGET_MS.tool_result_read_only`, and the hook
		// name in the subject is the other half of the same ternary pair. The
		// wrapper's own bound never fires here: at equal budgets the inner one
		// settles the handler first, which is why the EDIT case below is what
		// pins the `budgetKey` callback.
		expect(exceeded()).toEqual({
			"tool_result_read_only:handleToolResult":
				"exceeded 500ms budget after 500ms",
		});
	});

	it("gives an EDIT result the 10000ms budget and holds past 500ms", async () => {
		const settled = wedgedEmit({
			toolName: "edit",
			toolCallId: "ed-1",
			input: {
				path: filePath,
				oldText: "const a = 1;",
				newText: "const a = 2;",
			},
			content: [],
		});

		// Nothing has given up yet: the edit contract is 10s, not 500ms. This is
		// also the assertion that pins the WRAPPER's `budgetKey` — a callback
		// that answered read-only for an edit would fire its own
		// `tool_result_read_only:registered-handler` bound right here.
		await vi.advanceTimersByTimeAsync(500);
		expect(exceeded()).toEqual({});

		await vi.advanceTimersByTimeAsync(9_500);
		await settled;
		// Both sites, with the hook name each one chose: the inner bound and the
		// wrapper's `budgetKey` callback.
		expect(exceeded()).toEqual({
			"tool_result_edit:handleToolResult":
				"exceeded 10000ms budget after 10000ms",
			"tool_result_edit:registered-handler":
				"exceeded 10000ms budget after 10000ms",
		});
	});
});
