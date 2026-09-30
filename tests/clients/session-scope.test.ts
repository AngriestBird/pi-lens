/**
 * #3611 (S1 of the #3609 design): session scope tickets, the lineage handle,
 * and the process order turn, through real coordinators, the real widget
 * store, the real observed-mutation net and the real degradation ledger.
 *
 * The recurrences these prevent:
 * - N3 (#3540 case A): a `/reload` that re-evaluates the entry module builds
 *   a new coordinator whose per-instance order turn restarts, while the
 *   widget module keeps its write guards, so the live session's own verdict
 *   is dropped as older.
 * - N4: two coordinators' session generations both start at 0, so the
 *   process-wide observed-mutation net diffs one session's baseline against
 *   another session's call.
 * - A handle that stays current after its session's `session_shutdown`, or
 *   after a `/tree`, and so lets a late writer land in state the conversation
 *   no longer holds.
 *
 * A "simulated entry re-evaluation" here is the real thing: `vi.resetModules`
 * plus a dynamic import evaluates `runtime-coordinator.js` (and
 * `session-scope.js`) a second time, while the widget module this file
 * imported statically stays the one module, as `clients/` modules do across
 * a `/reload` (design §1.3).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { resetMutationAttribution } from "../../clients/mutation-attribution.js";
import {
	armObservedMutation,
	type ObservedReplayEntry,
	resetObservedMutationNet,
	settleObservedMutation,
} from "../../clients/observed-mutation.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { beginScope, retireScope } from "../../clients/session-scope.js";
import {
	clearWidgetState,
	getFileDiagnostics,
	recordDiagnostics,
} from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

type CoordinatorModule = typeof import("../../clients/runtime-coordinator.js");

/** A second evaluation of the coordinator module, as a `/reload` fallback makes. */
async function reEvaluatedCoordinatorModule(): Promise<CoordinatorModule> {
	vi.resetModules();
	return (await import("../../clients/runtime-coordinator.js")) as CoordinatorModule;
}

function staleWriteSubjects(): string[] {
	return getDegradationSummary()
		.filter((group) => group.kind === "generation-guard-stale-write")
		.flatMap((group) => group.latestReasons.map((r) => r.subject));
}

let env: ReturnType<typeof setupTestEnvironment>;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-3611-scope-");
	clearWidgetState();
	resetDegradationLedger();
	resetObservedMutationNet();
	resetMutationAttribution();
});

afterEach(() => {
	clearWidgetState();
	env.cleanup();
});

describe("#3611 N3: the order turn is one process counter", () => {
	it("a turn-1 widget write from a re-evaluated coordinator outranks a turn-5 token from the first", async () => {
		const file = path.join(env.tmpDir, "a.ts");
		const first = new RuntimeCoordinator();
		first.resetForSession();
		for (let turn = 0; turn < 5; turn += 1) first.beginTurn();
		expect(
			recordDiagnostics(
				file,
				[{ message: "from session 1", severity: "error", line: 1 }],
				first.nextWriteOrderToken(),
			),
		).toBe(true);

		// `/reload` re-evaluates the entry: a new coordinator, same widget module.
		const { RuntimeCoordinator: ReEvaluated } =
			await reEvaluatedCoordinatorModule();
		const second = new ReEvaluated();
		second.resetForSession();
		second.beginTurn();
		expect(second.turnIndex).toBe(1);

		expect(
			recordDiagnostics(
				file,
				[{ message: "from session 2", severity: "error", line: 1 }],
				second.nextWriteOrderToken(),
			),
		).toBe(true);
		expect(getFileDiagnostics(file)?.map((d) => d.message)).toEqual([
			"from session 2",
		]);
	});
});

describe("#3611 N4: scope tickets are process-unique", () => {
	it("two coordinators' session generations never compare equal in the observed-mutation settle", async () => {
		const file = path.join(env.tmpDir, "patched.ts");
		fs.writeFileSync(file, "const a = 1;\n");
		const first = new RuntimeCoordinator();
		first.resetForSession();
		const { RuntimeCoordinator: ReEvaluated } =
			await reEvaluatedCoordinatorModule();
		const second = new ReEvaluated();
		second.resetForSession();

		// Session 1 arms a baseline for a call id; session 2 settles that id.
		await armObservedMutation({
			toolCallId: "call-3611",
			toolName: "patch_file",
			targetPath: file,
			cwd: env.tmpDir,
			sessionGeneration: first.sessionGeneration,
			turnIndex: 1,
		});
		fs.writeFileSync(file, "const a = 2;\n");
		const replayed: ObservedReplayEntry[] = [];
		const settled = await settleObservedMutation({
			toolCallId: "call-3611",
			toolName: "patch_file",
			sessionGeneration: second.sessionGeneration,
			turnIndex: 1,
			record: (entry) => {
				replayed.push(entry);
				return true;
			},
		});

		expect(settled).toMatchObject({
			settled: false,
			reason: "session-generation-advanced",
		});
		expect(replayed).toEqual([]);
		expect(second.sessionGeneration).not.toBe(first.sessionGeneration);
	});
});

describe("#3611 the lineage handle", () => {
	it("stops being current when its scope retires at session_shutdown, and its write drops with the runtime-session record", () => {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		const handle = runtime.captureSessionGeneration();
		expect(handle.isCurrent()).toBe(true);
		expect(handle.generation).toBe(runtime.sessionGeneration);

		retireScope(runtime.sessionScope, "reload");

		expect(handle.isCurrent()).toBe(false);
		expect(runtime.isCurrentSession(handle.generation)).toBe(false);
		expect(handle.guardedWrite("late-write", () => "landed")).toBeUndefined();
		expect(staleWriteSubjects()).toEqual(["runtime-session:late-write"]);
	});

	it("is superseded by resetForSession, which draws a fresh ticket and names its predecessor", () => {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		const before = runtime.captureSessionGeneration();
		const previous = runtime.sessionScope;

		runtime.resetForSession();

		expect(before.isCurrent()).toBe(false);
		expect(previous.retiredBy()).toBe("superseded");
		expect(runtime.sessionScope.parentScopeId).toBe(previous.scopeId);
		expect(runtime.sessionGeneration).not.toBe(previous.scopeId);
		const after = runtime.captureSessionGeneration();
		expect(after.isCurrent()).toBe(true);
		expect(after.guardedWrite("own-write", () => "landed")).toBe("landed");
	});

	it("goes branch-stale on /tree and stays session-current; a handle with no /tree is current at both levels", () => {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		const handle = runtime.captureSessionGeneration();
		expect(handle.isCurrent("session")).toBe(true);
		expect(handle.isCurrent("branch")).toBe(true);

		runtime.readGuard.retainBranch(new Set());

		expect(handle.isCurrent("session")).toBe(true);
		expect(handle.isCurrent("branch")).toBe(false);
		// One epoch: the read guard's is its scope's.
		expect(runtime.readGuard.currentBranchEpoch).toBe(
			runtime.sessionScope.branchEpoch(),
		);
		expect(runtime.captureSessionGeneration().branchEpoch).toBe(
			handle.branchEpoch + 1,
		);
	});

	it("keeps the primary current when a secondary's scope retires", () => {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		const primary = runtime.captureSessionGeneration();
		const secondary = beginScope({ role: "secondary" });
		expect(secondary.scopeId).not.toBe(runtime.sessionGeneration);

		retireScope(secondary, "quit");

		expect(primary.isCurrent("branch")).toBe(true);
		expect(runtime.sessionScope.isLive()).toBe(true);
	});

	it("ends a scope whose shutdown carried no reason", () => {
		// An older host or an RPC shutdown can omit the reason; the scope must
		// still stop being current.
		const scope = beginScope({ role: "primary" });
		const handle = scope.capture();
		retireScope(scope, undefined);
		expect(scope.isLive()).toBe(false);
		expect(scope.retiredBy()).toBe("shutdown");
		expect(handle.isCurrent()).toBe(false);
	});

	it("keeps the first retirement reason when a scope is retired twice", () => {
		const scope = beginScope({ role: "primary" });
		retireScope(scope, "reload");
		retireScope(scope, "superseded");
		expect(scope.retiredBy()).toBe("reload");
	});
});
