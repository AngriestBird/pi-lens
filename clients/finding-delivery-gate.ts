/**
 * Single documentation home for the finding-delivery gate stack (#1634).
 *
 * Every store that renders findings to the AGENT — the turn-end blocker/
 * advisory tiers, `lens_diagnostics` mode=full/all, the widget/footer tally,
 * agent nudges, and the persisted project-diagnostics snapshot — invented its
 * own freshness and retirement rules across #1461/#1561/#1622/#1631, so the
 * stores drifted from each other and each new store re-created the class.
 * #1622/#1625/#1627/#1633 converged on two gates; this module names them ONE
 * time so every other file points here instead of re-explaining the contract.
 *
 * ── Freshness (mtime vs scannedAt, onMissing policy) ──────────────────────
 * `gateFindingsByPathFreshness` (advisory-provenance.ts) partitions a cached
 * store's findings by what the cited path looks like NOW versus the scan
 * timestamp (`scannedAt`) the store was captured at:
 *   - missing  → `onMissing: "drop"` (default) removes the finding outright —
 *     right when the finding IS the file's content (a secret in a deleted
 *     file cannot be rotated). `onMissing: "demote"` keeps it — right when the
 *     cited path is only EVIDENCE for a finding pinned elsewhere (a
 *     govulncheck CVE is pinned by go.mod, not by the traced call site).
 *   - stale (mtime > scannedAt) → DEMOTE, never drop. The finding survives,
 *     the now-untrustworthy line number does not.
 *   - live  → deliver unchanged, full authority.
 *   - unknown (unparseable/absent `scannedAt`, unreadable path) → fail OPEN,
 *     deliver unchanged. A missed demotion is noise; a wrong drop can hide a
 *     live credential or CVE.
 * The turn-end secrets (gitleaks/trivy-secrets) and govulncheck advisory both
 * route through this gate in `clients/runtime-turn.ts`.
 *
 * The SAME freshness family, one level up, covers cross-file drift: a cached
 * inline blocker is a verdict about its file *and everything that file
 * imports* — `clients/blocker-freshness.ts` (`sweepInlineBlockerFreshness`,
 * the widget-store counterpart `reconcileStaleWidgetDependencyBlockers`
 * paired with `reconcileStaleWidgetFiles`) stats the file and its forward
 * imports against the verdict's `recordedAtMs` baseline (#1631/#1633). A
 * drifted entry is demoted with the SAME `[stale — re-run to confirm]`
 * marker (`STALE_LINE_MARKER`, `clients/stale-marker.ts` — its own leaf
 * module so `widget-state.ts` can use it without a circular import back
 * through the turn orchestrator, #1631 review V2) and `isBlocking`
 * answers false for it — the one predicate both the footer tally and
 * `mode=all`'s blocking count consult, which is what keeps `mode=all` from
 * contradicting a same-minute `mode=full` sweep on the same paths (#1631
 * criterion 3 / #1634 criterion 4).
 *
 * Two INDEPENDENT gates share this `stale` field, distinguished by
 * `WidgetDiagnostic.staleReason`: `"dependency-drift"` (#1631, above) and
 * `"past-eof"` (#1641 — a cited line beyond the file's current on-disk length,
 * a stale in-memory LSP document diverged from disk). Each gate only HEALS
 * demotions it made itself (`staleReason` defaults to `"past-eof"` for
 * backward compatibility with pre-#1641 records) — composed, not merged into
 * one undifferentiated flag, so a fix for one hazard can never silently clear
 * the other's verdict.
 *
 * ── Dispositions (strict-only for blocking) ───────────────────────────────
 * `applyDispositions` (diagnostic-dispositions.ts) filters false-positive/
 * suppress/defer/flagged judgments the agent or user already recorded for a
 * finding. Anchoring is STRICT (line-content-hashed) only for false-positive
 * — a judgment about one exact piece of code that must NOT survive a rewrite
 * of that line — and WEAK (no line hash) for defer/flagged/suppress, which
 * are intent-level judgments that must survive incidental nearby edits.
 * `formatFullMode` (tools/lens-diagnostics.ts) applies this on every
 * mode=full pass; the per-edit dispatch path applies the identical filter
 * before writing into widget-state, so mode=all and the footer inherit
 * disposition state for any file that has gone through a live edit this
 * session WITHOUT re-computing it (kept cache-only and instant, #1634
 * criterion 5's documented exception — see "Explicit lag labels" below).
 *
 * ── Demotion rendering (#1419) ─────────────────────────────────────────────
 * A demoted finding is never silently dropped and never re-asserted at full
 * authority: it renders with `STALE_LINE_MARKER` (or the widget's `[stale]`
 * tag) in place of the coordinate the drift invalidated. This is the one
 * rendering convention every gated surface reuses — a store must not invent
 * its own "stale" wording.
 *
 * ── Explicit lag labels (the non-gated escape hatch) ──────────────────────
 * A store that cannot afford the freshness/disposition stack — because it
 * has no cited per-file path to stat (a package-pinned finding like a trivy
 * CRITICAL CVE or a license-risk row), or because re-computing dispositions
 * would cost the "instant" cache-only render mode=all/the footer promise —
 * MUST say so explicitly, with the finding's age, rather than presenting as
 * if it were current. `formatCacheAgeLabel` below is the one implementation;
 * every labeled surface in `DELIVERY_SURFACES` calls it instead of hand-
 * rolling an age string. This is the "(b)" arm of #1634's contract: every
 * agent-facing surface is EITHER gated OR explicitly labeled — never neither.
 */

const MS_PER_MINUTE = 60_000;

/**
 * Render a short, honest age suffix for a store that cannot be freshness-
 * gated per-path (see module doc). `undefined`/unparseable `scannedAt`
 * degrades to a neutral "scan age unknown" label — fail open on WORDING the
 * same way the freshness gate fails open on VERDICT: an unlabeled finding is
 * worse than a vague one, but never fabricate a number from a bad timestamp.
 */
export function formatCacheAgeLabel(
	scannedAt: string | number | undefined,
	nowMs: number = Date.now(),
): string {
	if (scannedAt === undefined || scannedAt === null || scannedAt === "") {
		return "scan age unknown";
	}
	const scannedAtMs =
		typeof scannedAt === "number" ? scannedAt : Date.parse(scannedAt);
	if (!Number.isFinite(scannedAtMs)) return "scan age unknown";
	const ageMs = Math.max(0, nowMs - scannedAtMs);
	const ageMinutes = Math.round(ageMs / MS_PER_MINUTE);
	if (ageMinutes < 1) return "scanned <1m ago";
	if (ageMinutes < 60) return `scanned ${ageMinutes}m ago`;
	const ageHours = Math.round(ageMinutes / 60);
	return `scanned ${ageHours}h ago`;
}

/** How a delivery surface satisfies #1634's "gated or labeled" contract. */
export type DeliveryMode = "gated" | "labeled";

interface DeliverySurfaceBase {
	/** Human-readable one-line description of what the surface renders. */
	description: string;
	/** Source file the surface's render/gate call lives in. */
	file: string;
}

export interface GatedDeliverySurface extends DeliverySurfaceBase {
	mode: "gated";
	/** Named gate(s) this surface routes through before rendering. */
	gates: string[];
}

export interface LabeledDeliverySurface extends DeliverySurfaceBase {
	mode: "labeled";
	/** Why this surface cannot take the full gate stack. */
	reason: string;
	/** What supplies the age shown to the agent (a scannedAt field, "live", or "n/a"). */
	ageSource: string;
}

export type DeliverySurfaceEntry = GatedDeliverySurface | LabeledDeliverySurface;

/**
 * The enumeration (#1634 criterion 1): every surface that renders findings to
 * the agent, derived by grepping the render seams — `blockerParts.push`/
 * `advisoryParts.push` in `clients/runtime-turn.ts`, the report builders in
 * `tools/lens-diagnostics.ts`, the widget footer's shared `isBlocking`/
 * reconcile predicates, `consumeAgentNudge`, and the persisted project-
 * diagnostics snapshot reconcile. Single source of truth: adding a new
 * render seam without adding an entry here fails
 * `tests/clients/finding-delivery-gate.test.ts`'s enumeration-completeness
 * check.
 */
export const DELIVERY_SURFACES: Record<string, DeliverySurfaceEntry> = {
	"runtime-turn:secrets-gitleaks": {
		mode: "gated",
		file: "clients/runtime-turn.ts",
		description: "Turn-end 🔴 secrets blocker, gitleaks cache.",
		gates: ["gateFindingsByPathFreshness"],
	},
	"runtime-turn:secrets-trivy": {
		mode: "gated",
		file: "clients/runtime-turn.ts",
		description: "Turn-end 🔴 secrets blocker, trivy secrets cache.",
		gates: ["gateFindingsByPathFreshness"],
	},
	"runtime-turn:govulncheck-advisory": {
		mode: "gated",
		file: "clients/runtime-turn.ts",
		description: "Turn-end 🛡️ Go CVE advisory (call-site line only).",
		gates: ["gateFindingsByPathFreshness"],
	},
	"runtime-turn:trivy-critical-blocker": {
		mode: "labeled",
		file: "clients/runtime-turn.ts",
		description: "Turn-end 🔴 CRITICAL dependency CVE blocker (trivy).",
		reason:
			"Package-pinned finding with no cited file:line to stat — freshness " +
			"has nothing to check drift against. The session_start cache can be " +
			"arbitrarily old, so its age is stated instead. Also routes through " +
			"`filterFindingsByDisposition` (#1625) first — a suppressed/false-" +
			"positive finding never reaches this render, so the age label and the " +
			"disposition filter compose rather than substitute for each other.",
		ageSource: "TrivyResult.scannedAt",
	},
	"runtime-turn:trivy-cve-advisory": {
		mode: "labeled",
		file: "clients/runtime-turn.ts",
		description: "Turn-end 🛡️ non-critical dependency CVE advisory (trivy).",
		reason:
			"Same package-pinned shape and #1625 disposition composition as the " +
			"CRITICAL blocker above.",
		ageSource: "TrivyResult.scannedAt",
	},
	"runtime-turn:trivy-license-advisory": {
		mode: "labeled",
		file: "clients/runtime-turn.ts",
		description: "Turn-end 📜 dependency license-risk advisory (trivy).",
		reason: "Same package-pinned shape as the CRITICAL blocker above.",
		ageSource: "TrivyResult.scannedAt",
	},
	"runtime-turn:dead-code-advisory": {
		mode: "labeled",
		file: "clients/runtime-turn.ts",
		description: "Turn-end dead-code delta advisory (knip/vulture/etc).",
		reason:
			"The delta shown is computed from THIS turn's own analyze() call, " +
			"diffed against the previous cache — never a replay of a stale cache.",
		ageSource: "live",
	},
	"runtime-turn:actionable-warnings-advisory": {
		mode: "labeled",
		file: "clients/runtime-turn.ts",
		description: "Turn-end actionable-warnings advisory (ast-grep etc).",
		reason:
			"`peekActionableWarnings` reads `_actionableWarningsThisTurn` — " +
			"recorded fresh from this turn's own dispatch, never a cross-turn cache.",
		ageSource: "live",
	},
	"lens-diagnostics:mode-full": {
		mode: "gated",
		file: "tools/lens-diagnostics.ts",
		description: "`lens_diagnostics mode=full` report.",
		gates: ["applyDispositions", "applyRulePolicy", "reconcileProjectDiagnosticsSnapshot"],
	},
	"lens-diagnostics:mode-all": {
		mode: "gated",
		file: "tools/lens-diagnostics.ts",
		description: "`lens_diagnostics mode=all` report (widget-state read).",
		gates: ["reconcileStaleWidgetFiles", "reconcileStaleWidgetDependencyBlockers"],
	},
	"widget-state:footer": {
		mode: "gated",
		file: "clients/widget-state.ts",
		description: "TUI footer blocking/error/warning tally.",
		gates: ["reconcileStaleWidgetFiles", "isBlocking"],
	},
	"agent-nudge:context-message": {
		mode: "labeled",
		file: "clients/agent-nudge.ts",
		description: "Post-edit file-touch nudge injected via `context`.",
		reason:
			"Not a scanner finding store: no severity, no cited line, no cache — " +
			"the accumulator is drained and cleared at the moment of injection, so " +
			"the content IS the current state by construction.",
		ageSource: "live",
	},
	"project-diagnostics:persisted-snapshot": {
		mode: "gated",
		file: "tools/lens-diagnostics.ts",
		description: "Cross-session persisted project-diagnostics snapshot read.",
		gates: ["reconcileProjectDiagnosticsSnapshot"],
	},
};

/**
 * Enforce #1634's "no third state" rule: every registered surface is either
 * `gated` (names at least one gate) or `labeled` (names a reason and an age
 * source) — never a malformed/undeclared third shape. Throws naming the
 * offending surface id, so a bad registration fails loudly instead of
 * silently rendering ungated.
 */
export function assertNoDeliveryBypass(
	registry: Record<string, DeliverySurfaceEntry> = DELIVERY_SURFACES,
): void {
	for (const [id, entry] of Object.entries(registry)) {
		if (entry.mode === "gated") {
			if (!Array.isArray(entry.gates) || entry.gates.length === 0) {
				throw new Error(
					`finding-delivery-gate: surface "${id}" is mode=gated but names no gate`,
				);
			}
			continue;
		}
		if (entry.mode === "labeled") {
			if (!entry.reason || !entry.ageSource) {
				throw new Error(
					`finding-delivery-gate: surface "${id}" is mode=labeled but is missing reason/ageSource`,
				);
			}
			continue;
		}
		throw new Error(
			`finding-delivery-gate: surface "${id}" has unrecognized mode ${JSON.stringify((entry as { mode?: unknown }).mode)} — must be "gated" or "labeled"`,
		);
	}
}
