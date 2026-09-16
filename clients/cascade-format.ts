import * as fs from "node:fs";
import type { CascadeNeighborResult, CascadeRun } from "./cascade-types.js";
import { retagAuxiliaryDiagnostics } from "./dispatch/auxiliary-lsp.js";
import {
	applyFindingPolicy,
	loadProjectRulePolicyMap,
	renderedRuleIdentities,
} from "./dispatch/finding-policy.js";
import { detectFileRole } from "./file-role.js";
import { logLatency } from "./latency-logger.js";
import type { LSPDiagnostic } from "./lsp/client.js";
import { convertLspDiagnostics } from "./dispatch/utils/lsp-diagnostics.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";

export function formatCascadeNeighborDiagnostics(
	cwd: string,
	neighbors: CascadeNeighborResult[],
	options: { noun?: string; includeReason?: boolean } = {},
): string {
	const withErrors = neighbors.filter((n) => n.diagnostics.length > 0);
	const inconclusive = neighbors.filter(
		(n) => n.inconclusive === true && n.diagnostics.length === 0,
	);
	// #1459: a neighbour whose scanner never looked at it is not a clean leaf. It
	// is also not `inconclusive` — the language server answered — so it gets its
	// own honest line instead of being folded into either bucket. Only the
	// zero-diagnostic case needs saying: a neighbour with findings already renders.
	const uncovered = neighbors.filter(
		(n) =>
			n.diagnostics.length === 0 &&
			n.inconclusive !== true &&
			(n.unconfirmedServerIds?.length ?? 0) > 0,
	);
	if (
		withErrors.length === 0 &&
		inconclusive.length === 0 &&
		uncovered.length === 0
	) {
		return "";
	}

	const noun = options.noun ?? "neighbor";
	let out =
		withErrors.length > 0
			? `📐 Cascade errors in ${withErrors.length} ${noun} file(s) — fix before finishing turn:`
			: "";
	for (const neighbor of withErrors) {
		const display = toRunnerDisplayPath(cwd, neighbor.filePath);
		const reason = options.includeReason ? ` reason="${neighbor.reason}"` : "";
		out += `\n<diagnostics file="${display}"${reason}>`;
		for (const d of neighbor.diagnostics) {
			const line = d.line ?? 1;
			const col = d.column ?? 1;
			const rule = d.rule ? ` rule=${d.rule}` : "";
			out += `\n  line ${line}, col ${col}${rule}: ${d.message.split("\n")[0].slice(0, 100)}`;
		}
		out += "\n</diagnostics>";
	}
	if (inconclusive.length > 0) {
		if (out) out += "\n";
		out += `⚠️ Cascade diagnostics inconclusive for ${inconclusive.length} ${noun} file(s) — no clean result was confirmed:`;
		for (const neighbor of inconclusive) {
			out += `\n  ${toRunnerDisplayPath(cwd, neighbor.filePath)}`;
		}
	}
	if (uncovered.length > 0) {
		if (out) out += "\n";
		out += `⚠️ Cascade scanners did not cover ${uncovered.length} ${noun} file(s) — no findings does NOT mean clean here:`;
		for (const neighbor of uncovered) {
			const servers = (neighbor.unconfirmedServerIds ?? []).join(", ");
			out += `\n  ${toRunnerDisplayPath(cwd, neighbor.filePath)} (not scanned by ${servers})`;
		}
	}
	return out;
}

/**
 * Build the turn-end `CascadeRun` for a neighbour whose diagnostics landed only
 * AFTER its cascade touch skipped the in-lane wait (#1023's `resolved-found`
 * quiet-window outcome; #1444 made native TS7 take that same path). Returns
 * `undefined` when there is nothing agent-facing to say — no ERROR-severity
 * diagnostics, or nothing the formatter renders.
 *
 * Lives here rather than inline in the quiet-window callback so the delivery
 * path (reconcile → run → turn_end) is testable end to end; index.ts only wires
 * it to `runtime.appendCascadeRun`.
 *
 * #3102: the survivors are what the agent READS, so they go through the same
 * `clients/dispatch/finding-policy.ts` stack — inline `pi-lens-ignore` → stored
 * dispositions → the project's `.pi-lens.json` rule policy — that the per-edit
 * dispatcher, `mode=full` and the `source=lsp` probe lane apply. Without it a
 * cold-neighbour ERROR the agent already marked `false-positive` came back on
 * every quiet-window reconcile.
 */
export function buildResolvedFoundCascadeRun(
	cwd: string,
	neighbor: { filePath: string; diagnostics: LSPDiagnostic[] },
): CascadeRun | undefined {
	const { filePath } = neighbor;
	const errors = neighbor.diagnostics.filter((d) => d.severity === 1);
	if (errors.length === 0) return undefined;
	const policyStart = Date.now();
	// One read of the neighbour, paid only once there is something to render.
	// `undefined` → the fail-open empty string: inline suppression becomes a
	// no-op and a STRICT `false-positive` anchor hashes an empty line, so a
	// finding is never hidden by an I/O error (AGENTS.md shape 48).
	const content = readNeighborContent(filePath);
	// No `range.start.line` pre-partition here, unlike the late-auxiliary drain,
	// whose own comment gives the alignment reason (`clients/runtime-turn.ts`,
	// above its `anchored` filter): `convertLspDiagnostics` drops line-less
	// entries, which would break the 1:1 index pairing `retagAuxiliaryDiagnostics`
	// needs. That reason holds here too — it is simply already satisfied. Both
	// lanes read the same `client.getAllDiagnostics()` map, whose
	// `mergeDiagnosticLists` (`clients/lsp/client.ts:1503`) dereferences
	// `diagnostic.range.start.line` unguarded, so a line-less entry throws long
	// before either builder sees it and `converted` is always 1:1 with `errors`.
	// The drain still partitions because its filter ALSO feeds a behaviour the
	// pairing does not: the `lateAuxMissing += rawDiags.length` arm it kept from
	// the pre-#3102 code. This builder has no such arm, so an unreachable copy
	// of the filter would buy nothing (round 2, F3).
	const converted = convertLspDiagnostics(errors, filePath);
	// #692/#3046: identity comes from the ONE shared derivation every other
	// surface anchors a mark against — never a hardcoded `tool: "lsp"`. Its drop
	// set is KEPT: these diagnostics come straight off the client's cache, so
	// nothing upstream applied `applyAuxiliarySuppressions` and this is the
	// FIRST application of the profile's own native comment / test-file gate,
	// not a double-apply (which is why the probe lane ignores it).
	const retained = retagAuxiliaryDiagnostics(converted, errors, content ?? "", {
		cwd,
		fileRole: detectFileRole(filePath, content),
	});
	const { kept: diagnostics } = applyFindingPolicy(retained, {
		cwd,
		filePath,
		content: content ?? "",
		policyMap: loadProjectRulePolicyMap(cwd),
		identities: renderedRuleIdentities,
	});
	// Policy drops only, DISJOINT from `auxSuppressed` below — the same split
	// the `late_auxiliary_findings` record uses, so one operator reading both
	// records does not have to know that one nests and the other does not.
	const suppressed = retained.length - diagnostics.length;
	const auxSuppressed = converted.length - retained.length;
	// Round 2 F1: gated on EITHER counter. Gating on the policy count alone made
	// an aux-only drop — an ERROR master rendered, removed here by the profile's
	// own `# nosemgrep` / `skipTestFiles` rule — vanish with no row at all, the
	// silent-drop shape this record exists to prevent (shape 10). The
	// `late_auxiliary_findings` twin reports both counters every drain.
	if (suppressed > 0 || auxSuppressed > 0) {
		// One bounded record per RUN, never one per finding (AGENTS.md "bounded
		// observability"). This is a PUSH surface: silence after a mark is the
		// mark working, not a clean verdict, so the count is recorded here rather
		// than re-announced to the agent on every reconcile. `durationMs` covers
		// the content read too — the latency this fold added to the quiet-window
		// callback, measurable in the same per-phase record as every other cost.
		logLatency({
			type: "phase",
			toolName: "cascade",
			filePath,
			phase: "cascade_finding_policy",
			durationMs: Date.now() - policyStart,
			metadata: { suppressed, total: converted.length, auxSuppressed },
		});
	}
	// No zero-length early return here: `formatCascadeNeighborDiagnostics`
	// renders "" for a neighbour with no diagnostics and the `!formatted` guard
	// below already returns `undefined` for it — a second check was mutation-
	// inert (M7: deleting it left all 7 cascade cases green).
	const neighbors: CascadeNeighborResult[] = [
		{ filePath, reason: "references", diagnostics, lspTouched: true },
	];
	const rendered = formatCascadeNeighborDiagnostics(cwd, neighbors, {
		noun: "cold neighbor",
	});
	if (!rendered) return undefined;
	// #1616 / #3102 AC 4, round 2 F2: a delivery that still has something to say
	// states what it dropped, once per delivery — the same sentence the
	// late-auxiliary advisory renders (`clients/runtime-turn.ts`). Policy drops
	// only: an aux drop is the file's own suppression comment, which the
	// per-edit dispatch path honours silently too, and it stays in the record
	// above. A delivery with NOTHING left says nothing at all — silence on a
	// push surface is not a claim that the neighbour is clean.
	const formatted =
		suppressed > 0
			? `${rendered}\nsuppressed by disposition: ${suppressed} finding(s) (marked false-positive or won't-fix).`
			: rendered;
	return {
		filePath,
		result: {
			filePath,
			impact: {
				filePath,
				changedSymbols: [],
				directImporters: [],
				directCallers: [],
				neighborFiles: [filePath],
				riskFlags: [],
			},
			neighbors,
			formatted,
		},
		neighborCount: 1,
		diagnosticCount: diagnostics.length,
	};
}

/**
 * The neighbour's current bytes, for the two content-bound halves of the
 * policy stack (inline `pi-lens-ignore` and the STRICT `false-positive`
 * anchor). One synchronous read, on a quiet-window callback that only runs
 * once a cold neighbour actually published ERROR diagnostics — the same
 * read `mode=full` pays per flagged file and the probe lane pays per cache
 * replay. `undefined` on any failure: the caller degrades to the
 * content-free half rather than hiding a finding it could not identify.
 */
function readNeighborContent(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Fix B (#3167): the carry label for a cascade run re-rendered at a later
 * turn_end. The carry is bounded to ONE turn (`RuntimeCoordinator.beginTurn`
 * drops anything that would reach 2), so the honest label names the carry
 * count; the run carries no observation timestamp, so no age half is claimed
 * here (the registry's own alternative — `formatCacheAgeLabel` from a run
 * stamp — has no stamp to read; the stamped surfaces, the demoted delta rows,
 * take the `formatCacheAgeLabel` label instead). Returns `undefined` for
 * non-carried runs: no label noise on fresh observations.
 */
export function cascadeCarrySuffix(carriedTurns?: number): string | undefined {
	if (carriedTurns === undefined || carriedTurns < 1) return undefined;
	const noun = carriedTurns === 1 ? "turn" : "turns";
	return `(carried ${carriedTurns} ${noun})`;
}
