/**
 * Session-state lifecycle registry — #1635 item 2.
 *
 * Eight bugs in the #1266–#1625 arc are one defect: state whose contract is
 * "durable for a SESSION" living in a process-lifetime container, with a reset
 * function that either nobody calls at `session_start` or that no test proves
 * re-arms anything. `#1266` (install-failure suppression), `#1490`/`#1540`
 * (PSScriptAnalyzer latches), `#1497` (install-retry ceiling), `#1535` (zizmor
 * token), `#1537` (lazy-install hold), `#1570` (classic-TS repair guard),
 * `#1618` (workspace sweep hold), `#1625` (deferred dispositions) — each was
 * found in production, one at a time, by a human noticing a tool stayed off.
 *
 * This registry makes that class checkable instead of noticeable. Every entry
 * declares:
 *
 * - WHERE the state lives (module + symbol), so a reader can go look;
 * - WHAT its reset policy is (`session_start`, `turn_end`, `process_lifetime`);
 * - WHICH exported reset implements that policy;
 * - and optionally a PROBE — arm the state, then prove the reset disarms it.
 *
 * `tests/clients/session-state-conformance.test.ts` then checks three things
 * the registry alone cannot assert:
 *
 * 1. every `session_start` entry's reset is genuinely reachable from
 *    `handleSessionStart` (DERIVED by `sessionStartResetNames()`, never a
 *    hand-copied list — that derivation is the whole point);
 * 2. every declared GAP is still a real gap, so a fix landing upstream turns
 *    the stale declaration red instead of leaving a lie in the file;
 * 3. every file the sweep flags as session-state-shaped is either registered
 *    or exempted with a reason.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	getDegradationSummary,
	recordDegradationOnce,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	acquireWorkspaceSweepHold,
	clearWorkspaceSweepHoldForSessionStart,
	isWorkspaceSweepActive,
} from "../../clients/lsp/workspace-sweep-hold.js";
import {
	_resetDeferredForTests,
	isDeferredThisSession,
	markDisposition,
} from "../../clients/diagnostic-dispositions.js";
import {
	_getReverseDepsIndexCacheKeysForTests,
	_seedReverseDepsIndexCacheForTests,
	clearReverseDepsIndexCache,
} from "../../clients/dispatch/integration.js";
import {
	createAvailabilityLatch,
	resetInstallRetryLatches,
} from "../../clients/dispatch/runners/utils/availability-policy.js";
import {
	getSharedTreeSitterClient,
	resetTreeSitterClientLoadState,
} from "../../clients/tree-sitter-shared.js";
import { removeTempDirSync } from "../clients/test-utils.js";

/**
 * When a piece of state must return to its initial value.
 *
 * `process_lifetime` is a legitimate answer — a memo of what the HOST looks
 * like does not change because the agent started a new session. It just has to
 * be stated, because "I meant it to be process-lived" and "I forgot to wire the
 * reset" are indistinguishable from the outside, and that ambiguity is the
 * whole defect class.
 */
export type SessionResetPolicy =
	| "session_start"
	| "turn_end"
	| "process_lifetime";

/** Arm the state, then check whether it is back in its post-reset shape. */
export interface SessionStateProbe {
	/** Put the state into a dirty, definitely-not-reset condition. */
	arm(): void;
	/** True when the state is in its initial, re-armed condition. */
	isArmed(): boolean;
	/** Run the entry's reset. Separate from `arm` so the test can order them. */
	reset(): void;
}

export interface SessionStateEntry {
	/** Stable id, used in failure output. */
	id: string;
	/** `clients/`-relative posix path of the module that owns the state. */
	module: string;
	/** The declaration(s) this entry covers, by name. */
	state: string;
	policy: SessionResetPolicy;
	/**
	 * The exported reset that implements `policy`. For state cleared by a
	 * METHOD call (`sessionFacts.clearAll()`), name the exported function that
	 * ENCLOSES the call — that is the seam a caller can actually reach, and the
	 * one the static reachability walk can see.
	 */
	resetName: string;
	/** Why this policy is the right one. One sentence, in the author's words. */
	reason: string;
	/**
	 * Set when `policy` is `session_start` but `resetName` is NOT wired into
	 * `handleSessionStart` today. The value states the gap and names the issue
	 * or PR that closes it. The conformance test asserts the gap is still real,
	 * so this cannot rot into a false claim after the fix lands.
	 */
	gap?: string;
	/** Optional runtime proof that the reset re-arms the state. */
	probe?: SessionStateProbe;
}

/** Throwaway cwds a probe created, removed by {@link _resetRegistryProbeState}. */
const scratchDirs: string[] = [];

/** Throwaway cwd for probes that need a project root on disk. */
function scratchCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-session-state-"));
	scratchDirs.push(dir);
	return dir;
}

export const SESSION_STATE_REGISTRY: SessionStateEntry[] = [
	// ── The named population from #1635 ──────────────────────────────────────
	{
		id: "degradation-ledger:onceKeys",
		module: "degradation-ledger.ts",
		state: "onceKeys, groups, tallies",
		policy: "session_start",
		resetName: "resetDegradationLedger",
		reason:
			"A once-per-session degradation notice that survives the session tells the next session's agent nothing happened when it did.",
		probe: {
			arm: () =>
				recordDegradationOnce({
					kind: "runner-unavailable",
					subject: "session-state-registry-probe",
					reason: "armed by the #1635 conformance probe",
					// biome-ignore lint/suspicious/noExplicitAny: the kind union is
					// owned by the ledger; the probe only needs a valid member.
				} as any),
			isArmed: () => getDegradationSummary().length === 0,
			reset: () => resetDegradationLedger(),
		},
	},
	{
		id: "workspace-sweep-hold:holds",
		module: "lsp/workspace-sweep-hold.ts",
		state: "holds, idleWaiters, nextHoldId",
		policy: "session_start",
		resetName: "clearWorkspaceSweepHoldForSessionStart",
		reason:
			"#1618: a hold leaked by a previous generation's sweep would defer the new session's idle reset forever.",
		probe: {
			arm: () => {
				acquireWorkspaceSweepHold();
			},
			isArmed: () => !isWorkspaceSweepActive(),
			reset: () => clearWorkspaceSweepHoldForSessionStart(),
		},
	},
	{
		id: "runner-helpers:correctedAvailabilityByCwd",
		module: "dispatch/runners/utils/runner-helpers.ts",
		state: "correctedAvailabilityByCwd, installAttemptsByCwd, resolveInstallInFlightByCwd",
		policy: "session_start",
		resetName: "resetDispatchAvailabilityState",
		reason:
			"#1615: the once-per-correction memo that suppresses repeat compensating rows is a per-session claim, so a new session must be able to log its own correction.",
	},
	{
		id: "runner-helpers:availabilityGeneration",
		module: "dispatch/runners/utils/runner-helpers.ts",
		state: "availabilityGeneration",
		policy: "session_start",
		resetName: "resetDispatchAvailabilityState",
		reason:
			"The generation counter is how every cwd-cached probe latch (eslint, clippy, and the rest of createCwdCachedProbe's users) re-arms without holding a reset closure per checker — one counter, not a parallel list of resets. #1754 made it a GenerationSource; resetDispatchAvailabilityState still owns the bump.",
	},
	{
		id: "availability-policy:installRetryLatches",
		module: "dispatch/runners/utils/availability-policy.ts",
		state: "installRetryGeneration (and each latch's install-class state)",
		policy: "session_start",
		resetName: "resetInstallRetryLatches",
		reason:
			"#1497: the install-retry ceiling is terminal for a SESSION, but the latches holding it live on bootstrap-built client instances — without this the ceiling is terminal for the process and a repaired network never re-earns its install.",
		probe: {
			arm: () => {
				const latch = createAvailabilityLatch();
				probeLatch = latch;
				// Escalate on the install ladder until the session ceiling latches.
				for (let i = 0; i < 12 && !latch.isInstallExhausted(); i++) {
					latch.noteUnavailable("transient", "probe-timeout", {
						operationClass: "install",
					});
				}
			},
			isArmed: () => probeLatch === undefined || !probeLatch.isInstallExhausted(),
			reset: () => resetInstallRetryLatches(),
		},
	},
	{
		id: "diagnostic-dispositions:deferredThisSession",
		module: "diagnostic-dispositions.ts",
		state: "deferredThisSession",
		policy: "session_start",
		resetName: "_resetDeferredForTests",
		reason:
			"A `defer` mark suppresses a diagnostic for THIS session by design; carrying it into the next session hides a finding nobody deferred.",
		gap:
			"Not wired: the only reset is the test-only seam, so a deferred diagnostic stays suppressed for the life of the PROCESS rather than the session. PR #1625 has now merged and did NOT close this (review round R1, S5): it scoped the Set's key per project and re-signed isDeferredThisSession, but added no session_start reset. The gap survives it and still needs an owner.",
		probe: {
			arm: () => {
				const cwd = scratchCwd();
				probeDeferredCwd = cwd;
				probeDeferredAnchor = markDisposition(
					cwd,
					{
						cwd,
						filePath: path.join(cwd, "probe.ts"),
						rule: "session-state-probe",
						message: "armed by the #1635 conformance probe",
						line: 1,
					},
					"defer",
					"conformance probe",
				);
			},
			isArmed: () => probeDeferredAnchor === undefined || !probeIsDeferred(),
			reset: () => _resetDeferredForTests(),
		},
	},
	{
		id: "dispatch-integration:reverseDepsIndexCache",
		module: "dispatch/integration.ts",
		state: "reverseDepsIndexCache",
		policy: "session_start",
		resetName: "clearReverseDepsIndexCache",
		reason:
			"A reverse-dependency index is a snapshot of a tree the next session may open at a different revision.",
		probe: {
			arm: () =>
				_seedReverseDepsIndexCacheForTests(
					"session-state-registry-probe",
					{
						projectRoot: "/probe",
						generatedAt: "now",
						imports: {},
						importedBy: {},
						source: "review-graph",
					},
					1,
				),
			isArmed: () => _getReverseDepsIndexCacheKeysForTests().length === 0,
			reset: () => clearReverseDepsIndexCache(),
		},
	},
	{
		id: "dispatch-integration:sessionCaches",
		module: "dispatch/integration.ts",
		state:
			"cascadeDiagnosticBaselines, neighborTouchCache, recentlyCleanNeighborCache, primaryFilesThisTurn, sessionSlopRuleCounts, sessionFacts",
		policy: "session_start",
		resetName: "resetDispatchBaselines",
		reason:
			"Every one of these is a claim about the tree as this session found it; `sessionFacts` is cleared by a method call inside this same reset, so the reset is the registered seam.",
	},
	{
		id: "dispatcher:coverageNoticeSeen",
		module: "dispatch/dispatcher.ts",
		state: "coverageNoticeSeen",
		policy: "session_start",
		resetName: "clearCoverageNoticeState",
		reason:
			"A once-per-session coverage notice must be sayable again to the next session's agent.",
	},
	{
		id: "tree-sitter-shared:webTreeSitterLoadFailed",
		module: "tree-sitter-shared.ts",
		state:
			"the shared TreeSitterClient singleton's webTreeSitterLoadFailed latch",
		policy: "session_start",
		resetName: "resetTreeSitterClientLoadState",
		reason:
			"#1592: an EVALUATION-shaped loadWebTreeSitter() rejection latches for the session (Node's ESM loader permanently memoizes the rejected module record for that URL, the same shape #1567/#1575 fixed for sgSessionHold) — but that verdict must not outlive the session that observed it, so a fresh session (or a process restart in between) gets a real re-attempt instead of a silently reused stale failure.",
		probe: {
			arm: () => {
				const client = getSharedTreeSitterClient() as unknown as {
					webTreeSitterLoadFailed: boolean;
				} | null;
				if (client) client.webTreeSitterLoadFailed = true;
			},
			isArmed: () => {
				const client = getSharedTreeSitterClient() as unknown as {
					webTreeSitterLoadFailed: boolean;
				} | null;
				return client ? client.webTreeSitterLoadFailed === false : true;
			},
			reset: () => resetTreeSitterClientLoadState(),
		},
	},

	// ── The rest of the session_start reset chain ────────────────────────────
	{
		id: "package-manager:availabilityLatches",
		module: "package-manager.ts",
		state: "availabilityLatches, inFlightProbes",
		policy: "session_start",
		resetName: "_resetPackageManagerCache",
		reason:
			"#1496 shape: a `missing` verdict for pnpm/yarn is durable for a session, not for the process — a manager installed mid-process should be re-probed by the next session. Declared a gap when this registry landed; PR #1666 wired the reset into handleSessionStart, and the gap test went red naming the fix, which is the registry doing its job.",
	},
	{
		id: "psscriptanalyzer:latches",
		module: "dispatch/runners/psscriptanalyzer.ts",
		state: "psAnalyzerLatchByCmd, psExecLatchByCmd",
		policy: "session_start",
		resetName: "resetPsScriptAnalyzerAvailability",
		reason:
			"#1490/#1540: these latches are module-local, so the availability generation counter does not reach them and they need their own session hook.",
	},
	{
		id: "zizmor-config:tokenAvailability",
		module: "zizmor-config.ts",
		state: "the `gh auth token` availability latch",
		policy: "session_start",
		resetName: "resetZizmorTokenAvailability",
		reason:
			"#1535: a user who runs `gh auth login` between sessions must not read the previous session's `no token` verdict.",
	},
	{
		id: "lazy-installer:attempts",
		module: "dispatch/runners/utils/lazy-installer.ts",
		state: "attempts",
		policy: "session_start",
		resetName: "resetLazyInstallAttempts",
		reason:
			"#1537: the lazy-install hold is durable for a SESSION; it deliberately sits here and not on the turn_end path, where a failing install would re-spawn every turn.",
	},
	{
		id: "smells-rollup:notifiedThisSession",
		module: "smells-rollup.ts",
		state: "notifiedThisSession",
		policy: "session_start",
		resetName: "resetSmellsSessionState",
		reason:
			"#1123: the once-per-session smell gate must let a fresh session hear the smell once.",
	},
	{
		id: "safe-spawn:windowsCommandCache",
		module: "safe-spawn.ts",
		state: "windowsCommandCache",
		policy: "session_start",
		resetName: "resetSafeSpawnWindowsCommandCache",
		reason:
			"A resolved Windows command path can be invalidated by an install that happened between sessions.",
	},
	{
		id: "workspace-topology:caches",
		module: "workspace-topology.ts",
		state: "dirMarkerCache, walkCache",
		policy: "session_start",
		resetName: "resetWorkspaceTopology",
		reason:
			"Workspace layout is re-derived per session; a new session can open a tree whose markers moved.",
	},
	{
		id: "workspace-modules:moduleSourceFilesMemo",
		module: "review-graph/workspace-modules.ts",
		state: "_moduleSourceFilesMemo",
		policy: "session_start",
		resetName: "clearModuleGraphCache",
		reason:
			"The module graph is a snapshot of the tree at session start, not a durable fact about the project.",
	},
	{
		id: "review-graph-builder:workspaceGraphCache",
		module: "review-graph/builder.ts",
		state: "_workspaceGraphCache, _workspaceCacheEpochs",
		policy: "session_start",
		resetName: "clearReviewGraphWorkspaceCache",
		reason:
			"Same reason as the module graph: a cached workspace graph describes one revision of one tree.",
	},
	{
		id: "ast-grep-napi:loadState",
		module: "dispatch/runners/ast-grep-napi.ts",
		state: "defaultUnsupportedLanguageLog, the NAPI load latch",
		policy: "session_start",
		resetName: "resetAstGrepUnsupportedLanguageLog",
		reason:
			"A failed native-module load is evidence about one moment, and the unsupported-language log is a once-per-session notice.",
	},
	{
		id: "installer:pathWalkMemo",
		module: "installer/index.ts",
		state: "pathWalkMemo",
		policy: "session_start",
		resetName: "resetPathWalkMemo",
		reason:
			"The PATH walk memo must not outlive a session that installed something onto PATH.",
	},
	{
		id: "lsp-server:classicTsRepairGuard",
		module: "lsp/server.ts",
		state: "the classic-tsserver repair guard",
		policy: "session_start",
		resetName: "resetClassicTsRepairGuard",
		reason:
			"#1570: a repair that failed transiently in an earlier session must not stay latched for the rest of the extension-host process.",
	},
	{
		id: "lsp-index:globalLSPService",
		module: "lsp/index.ts",
		state: "globalLSPService",
		policy: "session_start",
		resetName: "resetLSPService",
		reason:
			"The service is torn down and rebuilt per session; this reset is also the seam that carries the sweep hold and TS-repair guard resets.",
	},

	// ── Deliberately not session_start ───────────────────────────────────────
	{
		id: "formatters:runtimeState",
		module: "formatters.ts",
		state: "whichLatchByCommand, whichTransientCommands, cooldownRecordedForRetryAtMs",
		policy: "turn_end",
		resetName: "clearFormatterRuntimeState",
		reason:
			"Formatter resolution is re-derived every turn through `resetFormatService()`; #1537's note explains why the lazy-install hold specifically must NOT ride this turn-scoped reset.",
	},
];

/** Scratch state the probes above need to hold between `arm` and `isArmed`. */
let probeLatch: ReturnType<typeof createAvailabilityLatch> | undefined;
let probeDeferredAnchor: string | undefined;
let probeDeferredCwd: string | undefined;

/**
 * Read the defer set. `cwd` is part of the key since #1625: a weak anchor
 * encodes only a relative path, so the same anchor in two projects collided.
 */
function probeIsDeferred(): boolean {
	return isDeferredThisSession(
		probeDeferredCwd as string,
		probeDeferredAnchor as string,
	);
}

/** Drop probe scratch state so repeated conformance runs start clean. */
export function _resetRegistryProbeState(): void {
	probeLatch = undefined;
	probeDeferredAnchor = undefined;
	probeDeferredCwd = undefined;
	while (scratchDirs.length > 0) {
		removeTempDirSync(scratchDirs.pop() as string);
	}
}

/**
 * Files the sweep flags that the registry deliberately does not cover, each
 * with the reason it is not session-scoped state.
 *
 * This list is hand-maintained ON PURPOSE, exactly as
 * `tests/support/atomic-write-scan.ts`'s exemptions are: "is this a session
 * verdict or a memo of something that cannot change mid-process" is a semantic
 * judgment no regex makes. An entry here is a standing claim that carrying the
 * value across a `session_start` cannot mislead the agent.
 */
export const EXEMPT_SESSION_STATE_FILES: Readonly<Record<string, string>> = {
	// --- Host/toolchain derivations: the answer depends on the machine, not on
	// the session. Re-deriving per session would just re-pay a spawn. ---
	"lsp/jvm-runtime.ts": "resolved JVM location; a session boundary cannot move it",
	"review-graph/git-identity.ts": "git user identity, read once per process",
	"slow-fs.ts": "measured filesystem-latency classification of the host",
	"tui-fit.ts": "terminal truncation-behavior probe",
	"project-scale.ts": "project-scale base measurement, recomputed on its own inputs",
	"sgconfig.ts": "bundled ast-grep rule snapshots and baselines, shipped with the extension",
	"dispatch/runners/spotbugs.ts": "SpotBugs installation lookup, host-derived",
	"generated-artifacts.ts": "generated-file classification derived from path patterns",
	"git-tracked-ignore.ts":
		"git tracked/ignored sets, invalidated by their own mtime checks rather than by the session boundary",
	"blocker-freshness.ts":
		"grammar-load memo plus a turn-scoped forward-import parse memo keyed on each file's own mtime and size; both re-derive from disk, so a session boundary cannot make them lie",
	"diagnostic-line-freshness.ts":
		"the #1641 past-EOF line-count memo, keyed on mtime AND size and re-stat'd on every read — a mismatch always recomputes, so it is invalidated by its own freshness check per file, not by the session boundary, same as git-tracked-ignore.ts",
	"warm-attach.ts":
		"the warm-attach IPC server and incumbent-PID role, which belong to the process instance, not the session; its served-diagnostic dedupe is keyed by content hash, so a carried entry can only mean the answer is unchanged",

	// --- Configuration and feature-flag memos: read from env or a config file
	// whose own loader owns invalidation. A stale value here is a config read,
	// not a session verdict about a tool. ---
	"runtime-config.ts": "env-derived runner timeout floor",
	"subagent-mode.ts": "subagent-mode flag, fixed for the process by construction",
	"lsp-budget.ts": "cross-process LSP budget decision, re-read on its own cadence",
	"lsp/config.ts": "LSP config in-flight dedupe, per-load not per-session",
	"module-report-lsp.ts": "module-report LSP config memo",
	"project-lens-config.ts":
		"project .pi-lens config cache with its own mtime-based invalidation",
	"lens-config.ts": "global config warn-once set, tied to the config file it warned about",
	"instance-registry.ts": "instance-registry enablement flag",
	"session-lifecycle.ts":
		"the session_start decision seam itself — it is the boundary, not state behind it",

	// --- Event-bus and publisher singletons: registration state, reset only so
	// a test can re-register a fresh subscriber set. ---
	"bus-publish.ts": "bus publisher registration",
	"lens-events.ts": "lens event publisher registration",
	"disposition-publish.ts": "disposition publisher registration",
	"format-events-publish.ts": "format event publisher registration",
	"diagnostics-publish.ts": "diagnostics publisher registration and dirty-path dedupe",
	"bus-events-logger.ts": "bus event rollup counters, an observability tally",
	"ndjson-logger.ts": "registered log-file paths",
	"latency-logger.ts": "the latency log file handle",
	"quiet-window.ts": "quiet-window task registration",
	"quiet-window-config.ts":
		"the env-derived quiet-window kill switch and wait budget, split out of quiet-window.ts by #1462; a memo of configuration, not of a session verdict",
	"lsp/cascade-tier.ts": "cascade-tier registration and outstanding-touch bookkeeping",
	"dispatch/lazy.ts": "the lazy dispatch-integration import cell",
	"extension-log.ts": "console-method guard installation",
	"cache-observability.ts":
		"cache-prefix observation, already keyed by session id and cleared per session by its own caller",

	// --- Turn- or call-scoped working state: shorter-lived than a session, so
	// a session_start reset would be redundant, not missing. ---
	"agent-nudge.ts":
		"the nudge accumulator deliberately spans runs by design (see its own doc comment)",
	"git-guard.ts": "git-guard turn state, cleared on the turn path",
	"runtime-tool-result.ts": "in-flight pipeline and last-analyzed memo, per file and per call",
	"recent-touches.ts": "the recent-touch cursor, consumed and advanced per read",
	"widget-state.ts": "widget render state, rebuilt from the sources it displays",
	"word-index.ts": "word-index build guard, per build",
	"mcp/analyze.ts": "warm word-index cache keyed by path with its own freshness check",
	"mcp/session.ts":
		"MCP turn-end delivery chain, drained per turn; its session context is replaced, not accumulated",
	"project-report.ts": "project-report build guard, per build",
	"project-snapshot.ts":
		"snapshot parse caches keyed by content, invalidated by the snapshot generation they were built from",
	"review-graph/shared-extraction-ir.ts":
		"extraction IR keyed by cwd and file, invalidated by the graph build that produced it",
	"lsp/client.ts": "per-connection request bookkeeping, torn down with the connection",
	"project-changes.ts": "change-log sequence fold counter, an observability tally",
	"project-trust.ts":
		"install-refusal warn-once set, tied to the trust decision rather than the session",
	"lsp/workspace-diagnostics-cache.ts":
		"#1669 review F1/F2/N3: a sweep-cwd discovery registry (idempotent — re-registers on every createWorkspaceDiagnosticsCacheContext call) plus a per-cwd cache epoch. Neither needs a session_start reset, but a session boundary is NOT harmless for the registry: a refresh for a cwd this process has not yet swept clears nothing on disk (the review's N3 finding) until that cwd is finally reached, at which point clearWorkspaceDiagnosticsCache's state.root fallback and the epoch's on-disk generation field (durable across the boundary, unlike the in-memory map alone) recover it. A session_start wipe would only widen that window, not close it, so exemption is still correct — the fix is durability at the write site, not a reset seam here.",
};
