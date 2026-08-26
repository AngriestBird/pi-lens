/**
 * Concurrent-session guard (#473).
 *
 * In-process subagent extensions (tintinweb/pi-subagents-style: a fresh
 * `AgentSession` built and `bindExtensions()`-ed inside the SAME Node process
 * as the parent pi session) reuse pi's process-global extension-loader cache,
 * so the subagent's `session_start` re-invokes pi-lens's SAME module-scope
 * singletons the parent is still using. Left unguarded, `handleSessionStart`
 * destructively resets shared state (`resetLSPService({fast:true})` kills
 * every live LSP client; `runtime.resetForSession()` bumps the session
 * generation, silently orphaning the parent's in-flight continuations gated
 * on `isCurrentSession`) while the parent is mid-turn.
 *
 * pi's own SDK contract only invalidates a captured ctx for SEQUENTIAL
 * session replacement (`newSession`/`fork`/`switchSession`/`reload` —
 * `ExtensionRunner.invalidate()`, called from `core/agent-session.js` on
 * dispose). A concurrently-live sibling session's bind invalidates nothing.
 * That asymmetry — is the PRIOR ctx still active or not — is the reliable,
 * empirically-verified discriminator this module implements.
 *
 * Fail-safe direction is non-negotiable: whenever classification is
 * uncertain, this module falls back to today's behavior (treat as a
 * sequential replacement, i.e. run the full reset). It only suppresses the
 * reset on POSITIVE evidence that a live sibling primary session exists.
 *
 * Kill switch: `PI_LENS_CONCURRENT_SESSION_GUARD=0` disables the guard
 * entirely — every session_start classifies as if sequential (today's
 * behavior), matching the lazy-env-read house style (see
 * `subagent-mode.ts` / `runtime-config.ts`).
 */

import { normalizeFilePath } from "./path-utils.js";

/** Module-scope state — deliberately shared by construction. This module is
 * loaded once per process by pi's process-global extension cache, so a
 * concurrent in-process subagent session sees the SAME instance as the
 * parent, which is exactly the signal this guard relies on. */
let activeCtx: unknown | undefined;
let activeSessionId: string | undefined;
let activeRoot: string | undefined;
let secondarySessionCount = 0;

/** The stable id of the currently registered primary session, if known. */
export function getActiveSessionId(): string | undefined {
	return activeSessionId;
}

/**
 * The normalized project root of the currently registered primary session
 * (#2129), or `undefined` when no primary has registered a root yet.
 *
 * This is the process's answer to "which directory does pi-lens actually
 * serve", and it is what `memory_sample` carries as its root discriminator
 * (#2130) so a record from a multi-root host is attributable.
 */
export function getActivePrimaryRoot(): string | undefined {
	return activeRoot;
}

export type SessionStartClassification =
	| "primary"
	| "sequential-replacement"
	| "concurrent-secondary"
	| "secondary-root";

export interface ClassifySessionStartInput {
	/** Whether a primary session was already registered in this process. */
	hasPrior: boolean;
	/**
	 * Result of probing the prior primary's ctx via {@link probeCtxActive}:
	 * `true` = still active, `false` = confirmed invalidated (stale-ctx
	 * throw), `undefined` = probe inconclusive (ctx shape unexpected /
	 * accessor missing / prior ctx unavailable to probe).
	 */
	priorCtxActive: boolean | undefined;
	/** Whether this session_start carries the SAME stable session id as the
	 * registered primary (e.g. resume/reload re-announcing itself). */
	sameSessionId: boolean;
	/**
	 * #2129. Root identity relative to the registered primary's project root:
	 * `true` = same root, `false` = POSITIVELY a different root, `undefined` =
	 * unknown (no root recorded for the primary, or this start carries no cwd).
	 *
	 * `undefined` must never on its own change a verdict — the module's
	 * fail-safe direction (see the header) means only positive evidence of a
	 * DIFFERENT root may suppress a full session start.
	 */
	sameRoot?: boolean | undefined;
}

/**
 * PURE classifier — no I/O, no throws, fully unit-testable in isolation.
 *
 * Branches (fail-safe order matters):
 *  1. No prior primary registered → `primary` (first session_start this
 *     process has seen; zero behavior change for the single-session case).
 *  2. Prior exists, same stable session id → `sequential-replacement` (the
 *     same session re-announcing itself, e.g. resume/reload paths — must
 *     keep today's behavior, NOT be mistaken for a sibling).
 *  3. Prior exists, `priorCtxActive === false` (confirmed invalidated) →
 *     `sequential-replacement` (the prior really was replaced/disposed —
 *     this IS the sequential case pi's own contract covers).
 *  4. Prior exists, `priorCtxActive === true`, different session id →
 *     `concurrent-secondary` (positive evidence of a live sibling).
 *  5. Prior exists, different session id, `sameRoot === false` (positive
 *     evidence of a DIFFERENT project root) → `secondary-root` (#2129).
 *  6. Prior exists, `priorCtxActive === undefined` (probe inconclusive) →
 *     `sequential-replacement` (fail toward today's behavior).
 *
 * WHY ROOT IDENTITY IS AN INPUT AT ALL (#2129). Branch 3 alone made a subagent
 * temp worktree — a session_start in a DIFFERENT directory, arriving after the
 * host's real session had already been disposed or had an unprobeable ctx —
 * classify as a sequential replacement. It then re-registered itself as the
 * process's primary and ran the full session_start body: `resetLSPService`
 * killed the host's warm LSP fleet, and the whole async battery (opengrep,
 * word-index rebuild, review-graph build) re-ran per temp root over content
 * that had not changed. Two temp roots in one host cost ~50s of opengrep and
 * ~53s of word-index rebuild EACH, and drove host RSS from 290MB to 1.1GB in
 * four minutes.
 *
 * A start in a different root is therefore never allowed to steal primary. It
 * is a `secondary-root`, which the caller treats exactly like a
 * `concurrent-secondary`: skip the destructive resets and the expensive
 * battery, leave the registered primary's ctx/session id/root untouched. The
 * root still gets served — `initLSPConfig` registers session roots lazily,
 * per file (`clients/lsp/session-roots.ts:48`), not from this handler.
 *
 * Ordering note: the root check sits BELOW the `priorCtxActive === true`
 * branch so a live sibling still reports the more specific
 * `concurrent-secondary`, and it deliberately fires even when
 * `priorCtxActive === false`. "The prior ctx was invalidated" is exactly the
 * state a temp-worktree start arrives in, so deferring to it would restore the
 * defect.
 *
 * Accepted trade-off: an in-process SEQUENTIAL replacement that genuinely
 * moves to a new directory (a host that switches sessions across cwds within
 * one process) now takes the reduced path instead of a full start. It keeps
 * working — the LSP still attaches per file — but skips the startup battery
 * for the new root until a same-root start re-registers. `sameRoot` is only
 * ever `false` on positive evidence, and
 * `PI_LENS_CONCURRENT_SESSION_GUARD=0` disables this branch with the rest of
 * the guard.
 */
export function classifySessionStart(
	input: ClassifySessionStartInput,
): SessionStartClassification {
	const { hasPrior, priorCtxActive, sameSessionId, sameRoot } = input;

	if (!hasPrior) return "primary";
	if (sameSessionId) return "sequential-replacement";
	if (priorCtxActive === true) return "concurrent-secondary";
	if (sameRoot === false) return "secondary-root";
	if (priorCtxActive === false) return "sequential-replacement";
	// priorCtxActive === undefined: inconclusive probe — fail-safe.
	return "sequential-replacement";
}

/** Lazy env read (house style) — never memoized, so tests can flip it
 * mid-run via `process.env` without a reset hook. */
function guardEnabled(): boolean {
	return process.env.PI_LENS_CONCURRENT_SESSION_GUARD !== "0";
}

/**
 * Impure probe: exercises a cheap, side-effect-free ctx accessor that the
 * SDK's `ExtensionRunner.createContext()` wraps with `assertActive()`.
 *
 * Chosen accessor: `ctx.isIdle` (a bound method reading `runner.isIdleFn()`,
 * i.e. pure process/session state — no mutation, no I/O). It is wrapped the
 * same way every other guarded getter/method on the context is (`ui`,
 * `cwd`, `mode`, `signal`, `sessionManager`, ...): `assertActive()` runs
 * first and throws the SDK's stale-ctx error, matching the message fragment
 * `"stale after session replacement"`
 * (`ExtensionRunner.invalidate()`'s default message,
 * `core/extensions/runner.js` in the installed
 * `@earendil-works/pi-coding-agent` SDK dist). `isIdle` was picked over the
 * plain getters (`cwd`, `mode`, `hasUI`) only for readability at call sites
 * that already branch on idle state elsewhere in pi-lens; any of the other
 * assertActive()-wrapped accessors would work identically for this probe.
 *
 * Returns:
 *  - `true`  — the accessor call returned normally (ctx still active).
 *  - `false` — the accessor threw, and the message matches the known
 *    stale-ctx fragment (ctx confirmed invalidated by the SDK).
 *  - `undefined` — ctx has an unexpected shape (accessor missing / not a
 *    function), or the accessor threw something that does NOT look like the
 *    SDK's stale-ctx error (never assume — treat as inconclusive).
 *
 * Never throws out of this function; every branch is wrapped.
 */
export function probeCtxActive(ctx: unknown): boolean | undefined {
	try {
		const candidate = ctx as { isIdle?: unknown } | null | undefined;
		if (
			candidate === null ||
			candidate === undefined ||
			typeof candidate.isIdle !== "function"
		) {
			return undefined;
		}
		(candidate.isIdle as () => unknown)();
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("stale after session replacement")) {
			return false;
		}
		// Threw, but not the SDK's known stale-ctx error — don't guess.
		return undefined;
	}
}

/** Register the current session as the process's primary. Called for both
 * `primary` and `sequential-replacement` classifications — a sequential
 * replacement re-registers itself as the (new) primary, matching today's
 * one-active-session-at-a-time behavior. */
export function registerPrimarySession(
	ctx: unknown,
	sessionId: string | undefined,
	root?: string | undefined,
): void {
	activeCtx = ctx;
	activeSessionId = sessionId;
	// #2129: a re-registration that carries NO root must not erase a root the
	// previous primary did record — losing it would make every later start's
	// `sameRoot` read `undefined` (unknown) and silently restore the pre-fix
	// "any root may steal primary" behavior.
	if (root !== undefined) activeRoot = normalizeRootForCompare(root);
	secondarySessionCount = 0;
}

/**
 * Normalize a project root for identity comparison (#2129).
 *
 * Uses `normalizeFilePath` — the SAME comparator `registerInstance`
 * (`clients/instance-registry.ts:213`) writes roots with — so drive-letter
 * case, separators, and symlinked temp dirs cannot make two spellings of one
 * root look like two roots (catalog shape 1). Never throws: an unresolvable
 * path degrades to `undefined`, which reads as "root unknown" and leaves the
 * classification exactly where it was before this input existed.
 */
function normalizeRootForCompare(root: string | undefined): string | undefined {
	if (typeof root !== "string" || root.length === 0) return undefined;
	try {
		return normalizeFilePath(root);
	} catch {
		return undefined;
	}
}

/** Register a concurrently-bound secondary (subagent) session. Does not
 * touch the primary's ctx/session id. */
export function registerSecondarySession(): void {
	secondarySessionCount += 1;
}

export type SessionShutdownClassification = "primary" | "secondary";

/**
 * Classifies a `session_shutdown` firing the same fail-safe way as
 * `classifySessionStart`: it is `secondary` ONLY when a DIFFERENT primary is
 * registered (positively identified — ctx identity differs AND session ids
 * are both known and differ) and that primary's ctx still probes active
 * (positive evidence the shutting-down session is a live sibling, not the
 * real parent exiting). Any inconclusive signal — no primary registered,
 * same ctx object, same session id, EITHER session id unknown, or the
 * primary's ctx probe returning `undefined`/`false` — classifies as
 * `primary` so today's full-teardown behavior is preserved.
 *
 * The id-unknown guard matters: without it, a single ordinary session whose
 * `sessionManager.getSessionId()` is unavailable (SDK drift) would register
 * with `sessionId === undefined`, then at its OWN shutdown the same-id check
 * couldn't fire, the probe of its own (still-live — pi invalidates on
 * replacement, not shutdown) ctx would return true, and its teardown would
 * be skipped on EVERY clean exit — leaking the LSP fleet (the #472 orphan
 * class). Trade-off accepted: a REAL secondary that also has unknown ids
 * now classifies `primary` (conservative miss — its teardown runs and hurts
 * the parent, same as pre-#473 behavior), because uncertainty must never
 * classify `secondary`.
 */
export function noteSessionShutdown(
	// Load-bearing: ctx OBJECT IDENTITY is the definitive discriminator when
	// available — if the shutting-down handler's ctx IS the registered
	// primary's ctx, this is the primary regardless of session-id reads.
	// (Note: pi's ExtensionRunner.emit() builds a FRESH ctx object per emit,
	// so identity match is not expected with today's SDK — this check is
	// defense-in-depth for SDK versions/paths that reuse a ctx.)
	ctx: unknown,
	sessionId: string | undefined,
): SessionShutdownClassification {
	if (ctx !== undefined && ctx === activeCtx) {
		return "primary";
	}
	if (activeCtx === undefined && activeSessionId === undefined) {
		return "primary";
	}
	if (sessionId !== undefined && sessionId === activeSessionId) {
		return "primary";
	}
	// Uncertainty guard: if EITHER side's session id is unknown we cannot
	// positively establish "different session", so never classify secondary.
	if (sessionId === undefined || activeSessionId === undefined) {
		return "primary";
	}
	const primaryStillActive = probeCtxActive(activeCtx);
	if (primaryStillActive === true) {
		return "secondary";
	}
	// primaryStillActive is false or undefined: fail-safe to primary.
	return "primary";
}

/**
 * Read-only counterpart to {@link classifySessionStart}, usable from ANY
 * event handler (agent_end, turn_end, ...) rather than only session_start.
 * Unlike `decideSessionStart` this never mutates the module-scope
 * registration — repeated calls across a session's many agent_end/turn_end
 * firings are side-effect-free.
 *
 * Same fail-safe direction as the rest of this module: only returns
 * `"concurrent-secondary"` on POSITIVE evidence — a different, KNOWN session
 * id than the registered primary's, AND the registered primary's ctx still
 * probes active (i.e. a live sibling, not a primary that simply never
 * re-registered). Every uncertain case (no primary registered yet, same ctx
 * object, same session id, either id unknown, or the primary's probe isn't
 * affirmatively `true`) classifies as `"primary"` so today's behavior (run
 * the handler) is preserved. #791: used to skip the deferred-format flush at
 * `agent_end` for a concurrent secondary's own firing, mirroring how
 * `decideSessionStart` already skips `handleSessionStart`.
 */
export function classifyCurrentSessionEmission(
	ctx: unknown,
	sessionId: string | undefined,
): "primary" | "concurrent-secondary" {
	if (!guardEnabled()) return "primary";
	if (activeCtx === undefined && activeSessionId === undefined)
		return "primary";
	if (ctx !== undefined && ctx === activeCtx) return "primary";
	if (sessionId !== undefined && sessionId === activeSessionId)
		return "primary";
	// Uncertainty guard: if EITHER side's session id is unknown we cannot
	// positively establish "different session", so never classify secondary.
	if (sessionId === undefined || activeSessionId === undefined)
		return "primary";
	const primaryStillActive = probeCtxActive(activeCtx);
	if (primaryStillActive === true) return "concurrent-secondary";
	return "primary";
}

export function getSecondarySessionCount(): number {
	return secondarySessionCount;
}

export function decrementSecondarySessionCount(): void {
	if (secondarySessionCount > 0) secondarySessionCount -= 1;
}

/**
 * Guard-aware wrapper used by callers (index.ts) so the kill switch lives in
 * one place: when disabled, always report `sequential-replacement` (i.e.
 * behave exactly as if this module didn't exist).
 */
export function classifySessionStartGuarded(
	input: ClassifySessionStartInput,
): SessionStartClassification {
	if (!guardEnabled())
		return input.hasPrior ? "sequential-replacement" : "primary";
	return classifySessionStart(input);
}

/** Test-only: clears all module-scope state (house style — see
 * `_resetSubagentModeForTests` / `slow-fs.ts`). */
export function _resetSessionLifecycleForTests(): void {
	activeCtx = undefined;
	activeSessionId = undefined;
	activeRoot = undefined;
	secondarySessionCount = 0;
}

export interface SessionStartGuardDecision {
	classification: SessionStartClassification;
	/** True iff the caller should proceed with `handleSessionStart` + the
	 * rest of today's session_start body exactly as before. False means a
	 * concurrent secondary was detected — the caller must skip
	 * `handleSessionStart` (and `updateRuntimeIdentityFromEvent`) entirely. */
	runFullSessionStart: boolean;
	secondaryCount: number;
	/**
	 * #2129 observability: the root-identity input the classification actually
	 * consulted, so a log reader can tell "the root check ran and said same
	 * root" from "the root check had nothing to compare". Mirrors
	 * {@link ClassifySessionStartInput.sameRoot}.
	 */
	sameRoot: boolean | undefined;
	/** The registered primary's normalized root at decision time, if any. */
	primaryRoot: string | undefined;
}

/**
 * Single entry point `index.ts`'s `session_start` handler delegates to, so
 * the classify → probe → register decision is unit-testable independent of
 * the SDK's `pi.on("session_start", ...)` wiring (which cannot be invoked
 * directly in tests).
 *
 * `ctx` is whatever the SDK handed the handler (only ever probed via
 * {@link probeCtxActive}, never dereferenced otherwise, so passing a plain
 * fake object in tests is safe). `sessionId` is the STABLE session id
 * (`ctx.sessionManager.getSessionId()`), which may be `undefined`.
 */
export function decideSessionStart(
	ctx: unknown,
	sessionId: string | undefined,
	root?: string | undefined,
): SessionStartGuardDecision {
	const hasPrior = activeCtx !== undefined || activeSessionId !== undefined;
	const priorCtxActive = hasPrior ? probeCtxActive(activeCtx) : undefined;
	// ctx OBJECT IDENTITY: if the SDK ever hands the SAME ctx object to a
	// repeated session_start, that is by definition the same session
	// re-announcing itself — sequential, never concurrent. (Not expected with
	// today's SDK — ExtensionRunner.emit() builds a fresh ctx per emit — but
	// identity is the one signal that can't false-positive, so honor it.)
	const sameCtx = hasPrior && ctx !== undefined && ctx === activeCtx;
	const sameSessionId =
		sameCtx ||
		(hasPrior && sessionId !== undefined && sessionId === activeSessionId);

	// #2129: compare THIS start's cwd against the registered primary's root.
	// `undefined` on either side means "unknown", never "different" — see
	// `classifySessionStart`'s fail-safe note.
	const incomingRoot = normalizeRootForCompare(root);
	const sameRoot =
		hasPrior && activeRoot !== undefined && incomingRoot !== undefined
			? activeRoot === incomingRoot
			: undefined;

	const classification = classifySessionStartGuarded({
		hasPrior,
		priorCtxActive,
		sameSessionId,
		sameRoot,
	});

	if (
		classification === "concurrent-secondary" ||
		classification === "secondary-root"
	) {
		registerSecondarySession();
		return {
			classification,
			runFullSessionStart: false,
			secondaryCount: secondarySessionCount,
			sameRoot,
			primaryRoot: activeRoot,
		};
	}

	// "primary" or "sequential-replacement": register as the (new) primary
	// and proceed exactly as today.
	registerPrimarySession(ctx, sessionId, root);
	return {
		classification,
		runFullSessionStart: true,
		secondaryCount: secondarySessionCount,
		sameRoot,
		primaryRoot: activeRoot,
	};
}
