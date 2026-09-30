/**
 * Session scopes and the lineage handle (#3611, slice S1 of the #3609 design).
 *
 * pi re-runs the extension factory on every session transition except
 * `/tree`, and may re-evaluate the entry module on `/reload`, so the one
 * `RuntimeCoordinator` an evaluation holds cannot tell its sessions apart by
 * a per-instance counter: two evaluations' counters both start at 0 (N4), and
 * a per-evaluation order turn restarts while the widget's write guards, a
 * `clients/` module, keep their tokens (N3).
 *
 * The identity rule: **a lineage is a scope ticket, drawn from one process
 * counter when a scope begins. A handle is current while its scope is live
 * (session level) and, at branch level, while the scope's branch epoch equals
 * the one it captured.** A scope stops being live at its `session_shutdown`
 * or when its coordinator begins the next scope, and never becomes live
 * again. No session id, file or evaluation ordinal takes part in currency.
 *
 * The model is `formal/session-lifecycle/` (S9): tickets are its scope ids,
 * {@link retireScope} is its `Retire`, {@link moveBranch} its `Tree` epoch
 * bump, {@link nextOrderTurn} its `processOrderTurn`, and
 * {@link recordDroppedRead} its `recordDrop`.
 *
 * Handles hold their scope record by reference, so a retired scope needs no
 * registry lookup, and the process singleton holds two counters and nothing
 * that grows.
 */

import { incrementDegradationCount } from "./degradation-ledger.js";
import {
	createGenerationSource,
	type GenerationHandle,
} from "./generation-guard.js";
import { logLatency } from "./latency-logger.js";
import { getProcessSingleton } from "./process-singletons.js";
import { PI_LENS_EVALUATION_ORDINAL } from "./startup-timing.js";

export type ScopeRole = "primary" | "secondary";

/** `session`: the scope is live. `branch`: live, and no `/tree` since capture. */
export type LineageLevel = "session" | "branch";

/**
 * A `GenerationHandle`, so every existing `guardedWrite` site takes it
 * unchanged. `generation` is the scope ticket.
 */
export interface LineageHandle extends GenerationHandle {
	readonly scopeId: number;
	/** The scope's branch epoch at capture. */
	readonly branchEpoch: number;
	isCurrent(level?: LineageLevel): boolean;
}

export interface SessionScope {
	readonly scopeId: number;
	readonly role: ScopeRole;
	/** The scope this one replaced in the same coordinator, if any. */
	readonly parentScopeId: number | undefined;
	/** The ticket of the scope its coordinator was constructed with. */
	readonly coordinatorId: number | undefined;
	branchEpoch(): number;
	isLive(): boolean;
	/** Why the scope stopped being live: pi's shutdown reason, "shutdown" when pi sent none, or "superseded". */
	retiredBy(): string | undefined;
	capture(): LineageHandle;
}

const REGISTRY_FAMILY = "session-scope.registry";
/** Bump when the registry's shape changes. */
const REGISTRY_VERSION = 1;

/**
 * Process-wide, so a second module evaluation continues both counters
 * instead of restarting them (catalog shape 25).
 */
function registry(): { nextTicket: number; orderTurn: number } {
	return getProcessSingleton(REGISTRY_FAMILY, REGISTRY_VERSION, () => ({
		nextTicket: 0,
		orderTurn: 0,
	}));
}

/**
 * Where a handle keeps the scope it names, for {@link recordDroppedRead}.
 * `Symbol.for`, so a handle from another module evaluation is still read.
 */
const CAPTURED_SCOPE = Symbol.for("pi-lens.session-scope.captured.v1");

interface CapturedScope {
	scope: Scope;
	branch: GenerationHandle;
}

class Scope implements SessionScope {
	readonly scopeId: number;
	readonly role: ScopeRole;
	readonly parentScopeId: number | undefined;
	readonly coordinatorId: number | undefined;
	private retiredReason: string | undefined;
	// The stale-write record keeps its `runtime-session:<subject>` subject.
	private readonly life = createGenerationSource("runtime-session");
	private readonly branch = createGenerationSource("session-branch");

	constructor(args: {
		role: ScopeRole;
		parentScopeId?: number;
		coordinatorId?: number;
	}) {
		const state = registry();
		state.nextTicket += 1;
		this.scopeId = state.nextTicket;
		this.role = args.role;
		this.parentScopeId = args.parentScopeId;
		this.coordinatorId = args.coordinatorId;
	}

	branchEpoch(): number {
		return this.branch.current();
	}

	isLive(): boolean {
		return this.retiredReason === undefined;
	}

	retiredBy(): string | undefined {
		return this.retiredReason;
	}

	/** The first reason wins. */
	retire(reason: string | undefined): void {
		if (this.retiredReason !== undefined) return;
		// A host that sends no reason still ends the scope.
		this.retiredReason = reason ?? "shutdown";
		this.life.bump();
	}

	moveBranch(): void {
		this.branch.bump();
	}

	capture(): LineageHandle {
		const life = this.life.capture();
		const branch = this.branch.capture();
		return {
			generation: this.scopeId,
			scopeId: this.scopeId,
			branchEpoch: branch.generation,
			isCurrent: (level: LineageLevel = "session") =>
				life.isCurrent() && (level === "session" || branch.isCurrent()),
			guardedWrite: (subject, write) => life.guardedWrite(subject, write),
			[CAPTURED_SCOPE]: { scope: this, branch },
		} as LineageHandle;
	}
}

/**
 * Begin a scope: draw its ticket. A coordinator begins one when constructed
 * and one per `resetForSession`; a declined secondary start begins its own.
 */
export function beginScope(args: {
	role: ScopeRole;
	parentScopeId?: number;
	coordinatorId?: number;
}): SessionScope {
	return new Scope(args);
}

/**
 * Retire a scope. Every handle it issued stops being current. Idempotent:
 * the first reason wins.
 */
export function retireScope(
	scope: SessionScope,
	reason: string | undefined,
): void {
	(scope as Scope).retire(reason);
}

/** `/tree`: the scope's branch epoch moves once; its handles go branch-stale. */
export function moveBranch(scope: SessionScope): void {
	(scope as Scope).moveBranch();
}

/**
 * The next write-order turn, from one process counter (N3). A turn drawn
 * later outranks every earlier token, whichever coordinator or module
 * evaluation drew it.
 */
export function nextOrderTurn(): number {
	const state = registry();
	state.orderTurn += 1;
	return state.orderTurn;
}

export type ScopeTransition = "start" | "shutdown" | "tree";

/**
 * One `session_scope_transition` row per scope start, retire and branch
 * move (design §3.7). `evaluationOrdinal` and `coordinatorId` answer N3's
 * residence question: distinct coordinator ids per pid across a `/reload`
 * mean the entry module was re-evaluated.
 */
export function logScopeTransition(
	scope: SessionScope,
	args: {
		transition: ScopeTransition;
		reason: string | undefined;
		sessionId?: string;
		cwd: string;
	},
): void {
	logLatency({
		type: "phase",
		phase: "session_scope_transition",
		filePath: args.cwd,
		durationMs: 0,
		metadata: {
			transition: args.transition,
			reason: args.reason,
			scopeId: scope.scopeId,
			parentScopeId: scope.parentScopeId,
			role: scope.role,
			branchEpoch: scope.branchEpoch(),
			sessionId: args.sessionId,
			evaluationOrdinal: PI_LENS_EVALUATION_ORDINAL,
			coordinatorId: scope.coordinatorId,
		},
	});
}

/**
 * F1 (maintainer decision A + C on #3609): a read-guard write that its
 * lineage fence dropped is a false block when its entry is still on its
 * writer's branch. Such a drop leaves one counted record carrying the scope's
 * retirement reason, so correct `/new` drops can be told from `/reload` and
 * resume false blocks. "Still on the branch" is read from the handle's own
 * capture, never from a live session: with no `/tree` since the capture, the
 * entries the writer held are still on its conversation's branch. When the
 * branch moved, the entry cannot be shown to be on it, and only the fence's
 * own stale-write record stays.
 */
export function recordDroppedRead(handle: LineageHandle, site: string): void {
	const captured = (
		handle as LineageHandle & { [CAPTURED_SCOPE]?: CapturedScope }
	)[CAPTURED_SCOPE];
	if (!captured?.branch.isCurrent()) return;
	// A handle whose scope is live and whose branch did not move is current,
	// so its guard never drops: a caller reaches here only after a retire.
	const reason = captured.scope.retiredBy();
	incrementDegradationCount({
		kind: "session-scope-read-dropped",
		subject: `${reason}:${site}`,
		reason: `a ${site} read-guard write of scope ${captured.scope.scopeId} was dropped after the scope retired (${reason}); its entry is still on its conversation's branch`,
	});
}
