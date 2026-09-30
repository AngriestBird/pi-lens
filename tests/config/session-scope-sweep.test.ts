/**
 * The #3609 governance ratchet (slice S8, landed with S1 in #3611): no NEW
 * session state outside the session-scope store.
 *
 * The recurrence it prevents: every G2/G5/G10/G18/G21 defect was a piece of
 * session state at a residence that picks its own transition behaviour — a
 * module-level map in a conversation-scoped file, an activation-closure `let`
 * that dies on `/fork` (`pendingForkSnapshot`, #3521/#3589), a
 * `RuntimeCoordinator` field that `resetForSession` stops clearing, or a
 * sidecar writer outside one persistence path (design §0, §3.8). Each
 * population is pinned by NAME at today's value (never by count alone,
 * catalog shape 36), so a new member reds until its author places it — in a
 * store, in a reset, or here with a written reason — and each migration
 * slice shrinks a pin in its own PR.
 *
 * Not here, and where it lands:
 * - §3.8 item 1 (every `scope: "store"` registry entry names a
 *   `defineSessionStore`, and back) and item 2.6 (every `spec.snapshot` is
 *   sync) need the store API, which lands with the first store in S2.
 * - §3.8 item 2.4 (every `pi.on` is wrapped) is
 *   `tests/clients/session-event-guard-sweep.test.ts`; the wrapper's `scope`
 *   option lands with the ambient lineage (S3/S4).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
	moduleContainerNames,
	repoRoot,
} from "../support/session-state-scan.js";
import {
	assertNonEmptyScan,
	assertSortedRegistry,
	matchingCloseIndex,
	stripSource,
} from "../support/sweep-kit.js";

/**
 * §3.8 item 2.1: module-level containers and `let`s in the
 * conversation-scoped files, by name. A new name reds; add it here only with
 * a comment saying why it is not a store.
 */
const CONVERSATION_MODULE_STATE: Readonly<Record<string, readonly string[]>> = {
	"clients/dispatch/pending-runner-findings.ts": [],
	"clients/mutation-bridge.ts": [],
	"clients/quiet-window.ts": ["_builtinsRegistered", "_inProgress"],
	"clients/read-guard-branch.ts": [],
	"clients/read-guard-logger.ts": ["generatedCorrelationCounter"],
	"clients/read-guard.ts": [],
	"clients/runtime-agent-end.ts": [],
	"clients/runtime-coordinator.ts": [],
	"clients/runtime-session.ts": [],
	"clients/runtime-tool-call.ts": [],
	"clients/runtime-tool-result.ts": [
		"GIT_GLOBAL_OPTIONS_WITH_VALUE",
		"GIT_INTEGRATION_SUBCOMMANDS",
		"debouncedPipelines",
		"inFlightPipelines",
		"lastAnalyzedStateByFile",
	],
	"clients/runtime-turn.ts": ["lspIdleResetTimeout", "pendingSweepRearm"],
	"clients/session-scope.ts": [],
	"clients/test-runner-delivery.ts": ["pending"],
	"clients/tool-set-policy.ts": ["rememberedLazyToolsBySessionFile"],
	"clients/turn-summary.ts": [],
	"clients/widget-state.ts": [
		"diagnosticsWriteGuard",
		"files",
		"lspServers",
		"nextInactivePruneSize",
		"renderedDependencyDriftFiles",
		"requestRenderFn",
		"runnerWriteGuard",
		"sessionLanguages",
		"staleReconcileTimer",
	],
	"index.ts": [
		"_bridgeGetFlag",
		"_lspConfigInitializedCwds",
		"_mutationBridgeRegistered",
		"_nextTestRunnerDeliveryOwnerId",
		"_readBridgeRegistered",
		"_testRunnerDeliveryRegistered",
		"_turnSummaryEmitCtx",
		"_turnSummaryEmitRegistered",
		"cacheManager",
		"lastLoggedLoopWorstMs",
		"latestEventCtx",
		"loadedDispatchIntegration",
		"runtime",
		"sessionSuspectedStalls",
		"sessionWorstRealBlockMs",
	],
};

/**
 * §3.8 item 2.2: one-tab `let`s in `activateExtension`. They die with the
 * activation, which pi replaces on every transition except `/tree`.
 */
const ACTIVATION_STATE: Readonly<Record<string, string>> = {
	contextInjectionEnabled:
		"the /lens-context-toggle choice; D6 was not approved, so it resets per activation (N6 accepted)",
	lastSessionStartIdentity:
		"the #2890 duplicate-start gate, which must be per activation",
	lensEnabled:
		"the /lens-toggle choice; D6 was not approved, so it resets per activation (N6 accepted)",
	lensWidgetVisible:
		"the /lens-widget-toggle choice; D6 was not approved, so it resets per activation (N6 accepted)",
	mountedLensWidgetUi: "the UI this activation mounted its widget on",
	ownEventCtx: "the live ctx of this activation's own events",
	ownedSessionRole: "this activation's primary or secondary role (#1996)",
	pendingForkSnapshot:
		"the widget fork stash (#3589): dead on every real /fork; S2 replaces it with the hand-off slot and deletes this row",
	renderInvalidator: "this activation's widget repaint callback",
	scope: "this activation's session scope (#3611)",
	widgetMountFailureLogged: "a once-per-activation log latch for the mount",
};

/**
 * §3.8 item 2.3: every `RuntimeCoordinator` field and whether
 * `resetForSession` resets it. A new field reds until classified; a field
 * that stops being reset (or starts) reds too. `kept` fields carry a reason.
 */
const COORDINATOR_FIELDS: Readonly<Record<string, "reset" | string>> = {
	_actionableWarningsThisTurn: "reset",
	_autofixDemotedThisTurn: "reset",
	_cachedExports: "reset",
	_cascadeRuns: "reset",
	_cascadeSessionStats: "reset",
	_codeQualityWarningsThisTurn: "reset",
	_complexityBaselines: "reset",
	_coordinatorId:
		"kept: the construction scope's ticket names this coordinator on every session_scope_transition row (#3611)",
	_droppedMutationReceipts: "reset",
	_errorDebtBaseline:
		"kept: a project baseline (design A14), re-derived by its own producer",
	_fileLastProjectSeq: "reset",
	_fileSeq: "reset",
	_fixedThisTurn: "reset",
	_gitGuardCacheUnknownReason: "reset",
	_gitGuardHasBlockers: "reset",
	_gitGuardSummary: "reset",
	_hasStableSessionId: "reset",
	_inlineBlockerWriteOrder: "reset",
	_lifecycleReason:
		"kept: setSessionLifecycle sets it right after resetForSession at every primary start",
	_lspReadWarmState: "reset",
	_mutationReceipts: "reset",
	_nextCascadeSettleToken:
		"kept: a monotonic token source; restarting it would let an old settle's token match a new one",
	_pendingCascadeRuns: "reset",
	_pendingDeferredMutations: "reset",
	_pendingInlineBlockers: "reset",
	_pipelineCrashCounts: "reset",
	_projectRoot: "kept: the project, not the conversation (design A14)",
	_projectRulesScan:
		"kept: a project scan result with its own refresh (design A14)",
	_projectSeq: "reset",
	_readGuard: "reset",
	_readWidenings: "reset",
	_reportedThisTurn: "reset",
	_scope: "reset",
	_sessionStartedAt: "reset",
	_startupScansInFlight: "reset",
	_telemetryModel: "reset",
	_telemetryModelId: "reset",
	_telemetryProvider: "reset",
	_telemetryProviderIsExplicit: "reset",
	_telemetrySessionId: "reset",
	_toolCallAttributions: "reset",
	_turnEndCascadeSettleStarts: "reset",
	_turnIndex: "reset",
	_turnStartProjectSeq: "reset",
	_turnSummary: "reset",
	_viewLogEntries: "reset",
	_viewMissingThrough: "reset",
	_writeIndex: "reset",
	_writeOrderTurn:
		"kept: drawn from the process counter at every beginTurn (#3540 r2, #3611 N3)",
	_writtenThisTurn: "reset",
	callGraph: "kept: a project graph with its own freshness (design A14)",
	partialApplyRecords: "reset",
	wordIndex: "reset",
};

/**
 * §3.8 item 2.5: sidecar writers in the conversation-scoped files, by callee
 * and count. S2's one persistence path (`persistScope`) replaces them.
 */
const SIDECAR_WRITERS: Readonly<Record<string, readonly string[]>> = {
	"index.ts": ["saveSessionState", "saveSessionState", "saveSessionState"],
};

function read(relative: string): string {
	return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

/** The balanced body after the first match of `opener`, in stripped source. */
function bodyAfter(source: string, opener: RegExp): string {
	const match = opener.exec(source);
	if (!match) throw new Error(`no ${opener} in source`);
	const open = source.indexOf("{", match.index + match[0].length - 1);
	const close = matchingCloseIndex(source, open, "{", "}");
	if (close === -1) throw new Error(`unbalanced body after ${opener}`);
	return source.slice(open + 1, close);
}

function liveModuleState(relative: string): string[] {
	const lets = [
		...stripSource(read(relative)).matchAll(
			/^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)/gm,
		),
	].map((match) => match[1]);
	return [
		...moduleContainerNames(path.join(repoRoot, relative)),
		...lets,
	].sort();
}

function liveActivationLets(): string[] {
	const activation = bodyAfter(
		stripSource(read("index.ts")),
		/function activateExtension\s*\(/,
	);
	return [...activation.matchAll(/^\tlet\s+([A-Za-z_$][\w$]*)/gm)]
		.map((match) => match[1])
		.sort();
}

function liveCoordinatorFields(): Record<string, "reset" | "kept"> {
	const cls = bodyAfter(
		stripSource(read("clients/runtime-coordinator.ts")),
		/export class RuntimeCoordinator\b/,
	);
	const reset = bodyAfter(cls, /^\tresetForSession\s*\(/m);
	const fields = [
		...cls.matchAll(
			/^\t(?:(?:private|public|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*[:=?!]/gm,
		),
	].map((match) => match[1]);
	return Object.fromEntries(
		fields.map((field) => [
			field,
			// Assigned, or cleared through a method call, inside resetForSession.
			new RegExp(`this\\.${field}\\s*(?:=(?!=)|\\.\\w+\\s*\\()`).test(reset)
				? "reset"
				: "kept",
		]),
	);
}

function liveSidecarWriters(relative: string): string[] {
	return [
		...stripSource(read(relative)).matchAll(
			/\b(saveSessionState|writeFileAtomic\w*)\s*\(/g,
		),
	]
		.map((match) => match[1])
		.sort();
}

/** Both directions: a live name nobody pinned, and a pin nothing matches. */
function diffNames(
	label: string,
	live: readonly string[],
	pinned: readonly string[],
): string[] {
	const problems: string[] = [];
	const remaining = [...pinned];
	for (const name of live) {
		const at = remaining.indexOf(name);
		if (at === -1) problems.push(`UNPINNED ${label}: ${name}`);
		else remaining.splice(at, 1);
	}
	for (const name of remaining) problems.push(`STALE ${label}: ${name}`);
	return problems;
}

describe("session-scope ratchet (#3609 S8)", () => {
	it("keeps its pin tables sorted", () => {
		assertSortedRegistry(
			"CONVERSATION_MODULE_STATE",
			Object.keys(CONVERSATION_MODULE_STATE),
		);
		assertSortedRegistry("ACTIVATION_STATE", Object.keys(ACTIVATION_STATE));
		assertSortedRegistry("COORDINATOR_FIELDS", Object.keys(COORDINATOR_FIELDS));
	});

	it("admits no new module-level state in a conversation-scoped file (item 2.1)", () => {
		const problems: string[] = [];
		let scanned = 0;
		for (const [file, pinned] of Object.entries(CONVERSATION_MODULE_STATE)) {
			const live = liveModuleState(file);
			scanned += live.length;
			problems.push(...diffNames(file, live, [...pinned].sort()));
		}
		assertNonEmptyScan("conversation module state", scanned, 36);
		expect(problems).toEqual([]);
	});

	it("admits no new activation-closure let without a reason (item 2.2)", () => {
		const live = liveActivationLets();
		assertNonEmptyScan("activation-closure lets", live.length, 11);
		expect(
			diffNames(
				"activateExtension let",
				live,
				Object.keys(ACTIVATION_STATE).sort(),
			),
		).toEqual([]);
		for (const [name, reason] of Object.entries(ACTIVATION_STATE))
			expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
	});

	it("classifies every RuntimeCoordinator field by whether resetForSession resets it (item 2.3)", () => {
		const live = liveCoordinatorFields();
		assertNonEmptyScan(
			"RuntimeCoordinator fields",
			Object.keys(live).length,
			53,
		);
		const problems = diffNames(
			"RuntimeCoordinator field",
			Object.keys(live).sort(),
			Object.keys(COORDINATOR_FIELDS).sort(),
		);
		for (const [field, verdict] of Object.entries(live)) {
			const pinned = COORDINATOR_FIELDS[field];
			if (pinned === undefined) continue;
			const pinnedVerdict = pinned === "reset" ? "reset" : "kept";
			if (pinnedVerdict !== verdict)
				problems.push(
					`${field}: pinned ${pinnedVerdict}, resetForSession has it ${verdict}`,
				);
			if (pinnedVerdict === "kept" && pinned.length < 20)
				problems.push(`${field}: a kept field needs a reason`);
		}
		expect(problems).toEqual([]);
	});

	it("admits no new sidecar writer in a conversation-scoped file (item 2.5)", () => {
		const problems: string[] = [];
		for (const file of Object.keys(CONVERSATION_MODULE_STATE))
			problems.push(
				...diffNames(
					`${file} sidecar writer`,
					liveSidecarWriters(file),
					SIDECAR_WRITERS[file] ?? [],
				),
			);
		expect(problems).toEqual([]);
	});
});
