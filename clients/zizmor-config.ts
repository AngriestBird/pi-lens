import * as path from "node:path";
import { type SpawnResult, safeSpawnAsync } from "./safe-spawn.js";
import { findLocalToolConfig } from "./path-utils.js";
import { recordDegradation } from "./degradation-ledger.js";
import {
	type AvailabilityCause,
	type AvailabilityOutcome,
	classifyProbeFailure,
	createAvailabilityLatch,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.js";

/**
 * zizmor (GitHub Actions workflow security scanner) configuration discovery and
 * online-mode token resolution. zizmor runs as a cross-cutting auxiliary LSP
 * (#272); this module owns the two repo/environment-derived inputs the server
 * spawn and the auxiliary profile need.
 */

// zizmor discovers its config (curated ignores + per-rule config) as
// `zizmor.yml`/`.yaml` at the repo root or under `.github/` — see zizmor's
// configuration docs (discovery order: .github/zizmor.y[a]ml, then root). The
// presence of one is the repo's deliberate opt-in: it carries the author's
// chosen severities/ignores, so we let zizmor findings BLOCK in that workspace
// (advisory-only otherwise, like Opengrep's local-rules gate).
export const LOCAL_ZIZMOR_CONFIG_NAMES = [
	path.join(".github", "zizmor.yml"),
	path.join(".github", "zizmor.yaml"),
	"zizmor.yml",
	"zizmor.yaml",
] as const;

export function findLocalZizmorConfig(startDir: string): string | undefined {
	return findLocalToolConfig(startDir, LOCAL_ZIZMOR_CONFIG_NAMES);
}

// zizmor's own input collection (see `zizmor --collect`) only ever audits three
// path shapes: workflow YAML under `.github/workflows/`, a composite/reusable
// action definition (`action.yml`/`action.yaml`, anywhere in the repo — GitHub
// resolves these relative to whichever directory references them, not just the
// root), and the repo's Dependabot config (`.github/dependabot.yml`/`.yaml`,
// GitHub only ever reads this one location). Every other YAML file is a
// guaranteed no-op: measured directly against a real `zizmor --lsp` process
// (#<issue>), a non-matching file gets NO `publishDiagnostics` at all — not
// even an empty one — so `waitForDiagnostics` burns its full aggregateWaitMs
// budget (2000ms, bounded by the per-edit caller cap) on every such edit for
// zero signal (#636). This predicate is the LSP-candidacy gate (server.ts's
// `ZizmorServer.pathFilter`) that keeps zizmor out of the candidate list for
// files it can never report on, mirroring its own collection rules exactly —
// under-matching would silently drop real workflow/action coverage,
// over-matching would leave the wasted-wait gap in place for common
// non-GitHub YAML (docker-compose.yml, k8s manifests, …).
export function isZizmorAuditTarget(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	const base = path.basename(normalized).toLowerCase();
	if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(normalized)) return true;
	if (base === "action.yml" || base === "action.yaml") return true;
	if (/(^|\/)\.github\/dependabot\.ya?ml$/i.test(normalized)) return true;
	return false;
}

// A transient-aware latch for the `gh auth token` derivation (#1535, the
// #1467/#1494 permanent-probe-latch family). The old code folded EVERY
// failure — including a 5s host stall — into a memoized `{ value: undefined }`
// that stuck for the whole process, so a single slow `gh` disabled zizmor's
// GitHub-aware online audits (known-vulnerable-actions, unpinned-uses,
// impostor-commit) for the rest of the session while the scan still reported
// success. Only a genuine answer (gh ran and returned a real exit code, or is
// proven absent) latches now; a timeout/stall/unspawnable probe expires on the
// shared cooldown and is re-probed on the next call.
const ghTokenLatch = createAvailabilityLatch();
let cachedToken: string | undefined;

const GH_TOKEN_PROBE_TIMEOUT_MS = 5000;

/** Test-only: clear the memoized `gh auth token` lookup. */
export function _resetZizmorTokenCacheForTests(): void {
	ghTokenLatch.reset();
	cachedToken = undefined;
}

/**
 * Classify a failed `gh auth token` probe.
 *
 * `classifyProbeFailure`'s default branch treats ANY unrecognized failure —
 * including a spawn that never actually ran (EACCES, a resolution error, the
 * generic `spawn-failed` bucket) — as a durable `non-installable` verdict.
 * That is correct for a probe that ran and rejected, but wrong here: an
 * unspawnable prober never asked `gh` anything, so it must not be read as a
 * durable "no" (the lesson from this week's sibling-fix reviews on the
 * #1467/#1494 latch family). Only two shapes may latch: a completed run (any
 * exit code — that IS gh's answer) and a proven-absent `gh` binary.
 */
function classifyGhTokenFailure(
	res: SpawnResult,
	hostStallMs: number,
): { outcome: AvailabilityOutcome; cause: AvailabilityCause } {
	if (!res.error) {
		// The process ran to completion with a real (nonzero, since the zero
		// exit is handled before this is ever called) exit code — a genuine
		// "not authenticated" (or otherwise rejected) answer, safe to cache.
		return { outcome: "non-installable", cause: "probe-rejected" };
	}
	if (res.spawnFailure?.kind === "tool-not-found") {
		// gh genuinely isn't on PATH — a durable fact about the machine.
		return { outcome: "missing", cause: "not-found" };
	}
	const classified = classifyProbeFailure(res, { hostStallMs });
	if (classified.outcome === "transient" || classified.outcome === "missing") {
		return classified;
	}
	// Everything else (EACCES/permission-denied, cwd-unresolvable, a generic
	// spawn-failed, or an unrecognized errno) means the child never launched —
	// that's evidence about this moment, not about gh's auth state.
	return { outcome: "transient", cause: classified.cause };
}

async function deriveGhCliToken(): Promise<string | undefined> {
	const sampler = startHostStallSampler();
	const startedAt = Date.now();
	// Best-effort: a missing/unauthenticated `gh` just leaves zizmor offline.
	// ignoreAmbientSignal so a mid-turn Esc can't silently drop the server into
	// offline mode; short timeout so a wedged `gh` never stalls the warm spawn.
	// safeSpawnAsync never rejects (every failure resolves into `res`), so no
	// try/finally is needed to guarantee the sampler stops.
	const res = await safeSpawnAsync("gh", ["auth", "token"], {
		timeout: GH_TOKEN_PROBE_TIMEOUT_MS,
		ignoreAmbientSignal: true,
	});
	const hostStallMs = sampler.stop();
	const elapsedMs = Date.now() - startedAt;

	if (!res.error && res.status === 0) {
		const token = res.stdout.trim();
		ghTokenLatch.noteAvailable();
		logAvailabilityDecision({
			tool: "zizmor-gh-token",
			verdict: "available",
			outcome: "success",
			cause: "ok",
			elapsedMs,
			latched: true,
			hostStallMs,
			budgetMs: GH_TOKEN_PROBE_TIMEOUT_MS,
		});
		return token.length > 0 ? token : undefined;
	}

	const { outcome, cause } = classifyGhTokenFailure(res, hostStallMs);
	const retryAfterMs = ghTokenLatch.noteUnavailable(outcome, cause);
	if (outcome === "transient") {
		// The degradation itself: zizmor is about to run offline this turn
		// (known-vulnerable-actions/unpinned-uses/impostor-commit skipped) NOT
		// because the token is genuinely absent, but because this one probe
		// never got a fair hearing. Make that legible instead of letting the
		// scan silently report "clean" (#1459's security-silence shape).
		recordDegradation({
			kind: "mode-suppression",
			subject: "zizmor",
			reason: `gh auth token probe ${cause}; running offline this turn, retrying in ${Math.round(retryAfterMs / 1000)}s`,
		});
	}
	logAvailabilityDecision({
		tool: "zizmor-gh-token",
		verdict: "unavailable",
		outcome,
		cause,
		elapsedMs,
		latched: outcome !== "transient",
		hostStallMs,
		...(retryAfterMs > 0 && { retryAfterMs }),
		budgetMs: GH_TOKEN_PROBE_TIMEOUT_MS,
	});
	return undefined;
}

/**
 * Resolve a GitHub token to put zizmor into ONLINE mode, so the audits that need
 * the GitHub API (e.g. `known-vulnerable-actions`, `unpinned-uses`,
 * `impostor-commit`) actually run instead of being silently skipped.
 *
 * zizmor's own precedence: `ZIZMOR_OFFLINE` forces offline regardless of any
 * token; otherwise any of `GH_TOKEN` / `GITHUB_TOKEN` / `ZIZMOR_GITHUB_TOKEN`
 * enables online mode. Those env vars already flow to the spawned server
 * (launchLSP merges `process.env`), so the ONLY gap we close here is the very
 * common case of a user who has authenticated the `gh` CLI but exported no
 * token — we derive one via `gh auth token`. Memoized per process through a
 * transient-aware latch (#1535): only a genuine answer (gh ran and returned
 * an exit code, or is proven absent) is remembered for the session — a
 * timeout/stall/unspawnable probe expires on a cooldown and is re-derived on
 * the next call, so a single slow `gh` can't disable online audits forever.
 */
export async function resolveZizmorGitHubToken(): Promise<string | undefined> {
	// Respect an explicit offline request — never derive a token then.
	if (process.env.ZIZMOR_OFFLINE) return undefined;
	const fromEnv =
		process.env.ZIZMOR_GITHUB_TOKEN ||
		process.env.GH_TOKEN ||
		process.env.GITHUB_TOKEN;
	if (fromEnv) return fromEnv;
	const memo = ghTokenLatch.read();
	if (memo !== null) return memo ? cachedToken : undefined;
	cachedToken = await deriveGhCliToken();
	return cachedToken;
}
