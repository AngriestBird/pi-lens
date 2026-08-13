/**
 * Host project-trust gate (#1334 S5).
 *
 * pi decides project trust itself: an extension may *answer* the question by
 * registering `pi.on("project_trust", handler)` (returning
 * `{ trusted: "yes" | "no" | "undecided" }`), but every other extension simply
 * *consumes* the outcome through `ExtensionContext.isProjectTrusted()`. pi-lens
 * is a consumer — it must never register the handler and answer the trust
 * question on the user's behalf.
 *
 * Verified against the pinned host types
 * (`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`):
 *   - `ExtensionContext.isProjectTrusted(): boolean`  (line 234)
 *   - `ProjectTrustEventDecision = "yes" | "no" | "undecided"`  (line 390)
 *
 * Note the asymmetry: the *event* has a three-valued decision, but the *ctx*
 * accessor collapses it to a boolean. So the only distinctions pi-lens can make
 * are "host says trusted", "host says NOT trusted", and "host gave no signal at
 * all" (older hosts with no `isProjectTrusted` on the ctx).
 *
 * Policy:
 *   - `untrusted` — the host actively said no. Block the two things pi-lens
 *     does unprompted at session start that touch the outside world: tool
 *     auto-INSTALL (downloads + executes third-party binaries) and LSP child
 *     process SPAWN (executes project-resolved binaries, often from the
 *     project's own `node_modules`). Discovery, cached analysis, tree-sitter
 *     and every in-process code path continue — they spawn nothing.
 *   - `trusted` / `unknown` — current behavior, unchanged. Fail-open is
 *     deliberate ONLY for `unknown`: a host that never exposed the accessor
 *     never had a trust decision to honor, and degrading it would break every
 *     older pi.
 *
 * Process-wide singleton on purpose: `ensureTool()` and the LSP service sit
 * many layers below any `ctx`, and threading trust through every call site
 * would be a far larger and more fragile change than a single latched state
 * refreshed on each `session_start`.
 */

export type ProjectTrustState = "trusted" | "untrusted" | "unknown";

let trustState: ProjectTrustState = "unknown";

/**
 * Feature-detected read of the host trust decision off an event ctx.
 *
 * Returns `"unknown"` when the host predates the accessor, when the accessor
 * throws, or when it returns a non-boolean — never guesses "untrusted" from a
 * missing surface, because that would silently disable pi-lens on every older
 * host.
 */
export function readProjectTrustFromContext(ctx: unknown): ProjectTrustState {
	try {
		const accessor = (ctx as { isProjectTrusted?: unknown } | null | undefined)
			?.isProjectTrusted;
		if (typeof accessor !== "function") return "unknown";
		const trusted = (accessor as () => unknown).call(ctx);
		if (typeof trusted !== "boolean") return "unknown";
		return trusted ? "trusted" : "untrusted";
	} catch {
		return "unknown";
	}
}

/** Latch a trust state directly (tests, and the ctx adoption path below). */
export function setProjectTrustState(next: ProjectTrustState): void {
	trustState = next;
}

/**
 * Read the host decision off `ctx` and latch it. Called from `session_start`,
 * which fires again on fork/reload/resume — a re-read per session start is
 * exactly right, since the cwd (and therefore the trust decision) can change.
 */
export function adoptProjectTrustFromContext(ctx: unknown): ProjectTrustState {
	const next = readProjectTrustFromContext(ctx);
	trustState = next;
	return next;
}

export function getProjectTrustState(): ProjectTrustState {
	return trustState;
}

/** Test/teardown-only: back to the fail-open default. */
export function resetProjectTrust(): void {
	trustState = "unknown";
}

/**
 * False only when the host actively denied trust. Gates tool auto-install
 * (download + execute), never plain discovery of an already-present binary.
 */
export function isToolInstallAllowedByTrust(): boolean {
	return trustState !== "untrusted";
}

/**
 * False only when the host actively denied trust. Gates LSP server child
 * process spawns.
 */
export function isLspSpawnAllowedByTrust(): boolean {
	return trustState !== "untrusted";
}

/** Human/log-readable reason, or undefined when nothing is being blocked. */
export function projectTrustDenialReason(): string | undefined {
	return trustState === "untrusted"
		? "project is not trusted (host isProjectTrusted() === false)"
		: undefined;
}
