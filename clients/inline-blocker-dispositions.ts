/**
 * Disposition/rule/inline-suppression policy for the turn-end
 * "Unresolved from this turn" blocker replay (#3246).
 *
 * `runtime-turn.ts` re-serves every live `InlineBlockerRecord` the turn's
 * dispatches left behind. Until this module, it pushed the record's
 * ALREADY-RENDERED `summary` string verbatim, so a `lens_diagnostic_mark`
 * made after the record was written had nothing to act on: the durable
 * disposition store was honored by `lens_diagnostics`, the widget, the cached
 * scanner lanes, late auxiliary and cascade, while this one surface replayed
 * the pre-mark text on every later turn — including turns that edited only an
 * unrelated file. That is #3246's report.
 *
 * The fix is the same shape `blocker-past-eof.ts` already argued for the
 * `lines` field: carry the STRUCTURED diagnostics the summary was rendered
 * from (`dispatchResult.blockers`, via `PipelineResult.inlineBlockerDiagnostics`
 * and `InlineBlockerRecord.diagnostics`) and re-derive at read time, rather
 * than regex-parsing a string built for human display. With the diagnostics in
 * hand this module runs the ONE filter stack every other findings surface runs
 * — `clients/dispatch/finding-policy.ts`'s inline `pi-lens-ignore` → stored
 * dispositions → `.pi-lens.json` rule policy — against the file's CURRENT
 * bytes, and re-renders the survivors with `formatDiagnostics(..., "blocking")`,
 * the SAME renderer `dispatcher.ts` used to build the stored summary. No second
 * anchor implementation and no second renderer: an unmarked record therefore
 * re-renders byte-identically to what dispatch produced.
 *
 * Ordering (#3246 mutation (c)): the policy runs over the WHOLE candidate set
 * and `formatDiagnostics` applies its 10-row display cap to the survivors.
 * Filtering after the cap would leave a marked finding occupying a display slot
 * and hide an unmarked one behind "... and N more" — the cap-before-policy
 * shape `cascade-format.ts` already avoids.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { hasAnyDispositionMarks } from "./diagnostic-dispositions.js";
import {
	applyFindingPolicy,
	inlineBlockerIdentities,
	loadProjectRulePolicyMap,
} from "./dispatch/finding-policy.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import type { Diagnostic } from "./dispatch/types.js";
import { formatDiagnostics } from "./dispatch/utils/format-utils.js";

/**
 * The record fields this gate reads — structural, like `blocker-freshness.ts`
 * and `blocker-past-eof.ts`, so `runtime-coordinator.ts` stays the only owner
 * of `InlineBlockerRecord`.
 */
export interface InlineBlockerPolicyInput {
	filePath: string;
	summary: string;
	/** Absent on a legacy/hand-authored record — see `unstructured` below. */
	diagnostics?: readonly Diagnostic[];
}

export interface InlineBlockerPolicyOutcome {
	/**
	 * The blocker body to render, or `undefined` when the policy suppressed
	 * EVERY candidate — the caller then emits no `Unresolved from this turn`
	 * section and no `🔴 STOP` text for this file at all.
	 */
	body: string | undefined;
	/** Structured blockers this record offered the policy. */
	candidates: number;
	/** Survivors — what `body` renders. */
	kept: number;
	/** `candidates - kept`. */
	suppressed: number;
	/**
	 * True when the record carried no structured diagnostics, so its summary
	 * was re-served verbatim and no mark could be applied to it. Fail-open by
	 * construction: a finding is never hidden because its identity was
	 * unavailable.
	 */
	unstructured: boolean;
}

/**
 * The file's CURRENT bytes, or `""` when they cannot be read.
 *
 * `""` is `FindingPolicyOptions.content`'s documented fail-open input: inline
 * suppression becomes a no-op and the STRICT anchor hashes an empty line, so it
 * cannot match a mark made against real content and the finding stays VISIBLE.
 * Never hide a blocking finding over an I/O error (AGENTS.md shape 48).
 */
function readCurrentContent(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

/**
 * Apply the shared finding policy to one live inline-blocker record.
 *
 * Diagnostics are grouped by the file they were raised AGAINST, not by the
 * record's own path: `dispatchResult.blockers` is pooled across every runner
 * dispatched for the edited file, and a chart-wide runner (helm-lint,
 * helm-render) reports blocking diagnostics against sibling files — the same
 * cross-file population `pipeline.ts` filters out of `inlineBlockerLines`.
 * Anchoring those against the record's path would derive the wrong strict
 * anchor and read the wrong file's `pi-lens-ignore` comments.
 */
export function applyInlineBlockerPolicy(
	record: InlineBlockerPolicyInput,
	cwd: string,
): InlineBlockerPolicyOutcome {
	const diagnostics = record.diagnostics;
	if (!diagnostics || diagnostics.length === 0) {
		// Bounded per (kind, subject) by the ledger itself — this condition
		// recurs every turn end for the same record, so a counted row would
		// grow without adding information (AGENTS.md shapes 13/17). Recorded
		// ONLY when the project actually holds marks: with an empty store there
		// is nothing this record failed to honor, and a row every session for
		// every unstructured record would be noise, not a degradation.
		if (hasAnyDispositionMarks(cwd)) {
			recordDegradationOnce({
				kind: "inline-blocker-unstructured",
				subject: `inline-blocker:${toRunnerDisplayPath(cwd, record.filePath)}`,
				reason:
					"record carries no structured diagnostics; disposition marks cannot be applied to its rendered summary",
			});
		}
		return {
			body: record.summary,
			candidates: 0,
			kept: 0,
			suppressed: 0,
			unstructured: true,
		};
	}

	const byFile = new Map<string, Diagnostic[]>();
	for (const diagnostic of diagnostics) {
		// Resolved against the PROJECT root, never `process.cwd()`: a runner that
		// reports a project-relative path would otherwise be grouped under the
		// agent host's working directory and read the wrong file's bytes.
		const owner = path.resolve(cwd, diagnostic.filePath);
		const group = byFile.get(owner);
		if (group) group.push(diagnostic);
		else byFile.set(owner, [diagnostic]);
	}

	// `loadPiLensProjectConfig` is mtime-cached, so several groups cost one stat.
	const policyMap = loadProjectRulePolicyMap(cwd);
	const dropped = new Set<Diagnostic>();
	for (const [filePath, group] of byFile) {
		const { kept } = applyFindingPolicy(group, {
			cwd,
			filePath,
			content: readCurrentContent(filePath),
			policyMap,
			identities: inlineBlockerIdentities,
		});
		const survivors = new Set(kept);
		for (const diagnostic of group) {
			if (!survivors.has(diagnostic)) dropped.add(diagnostic);
		}
	}

	const kept =
		dropped.size === 0
			? [...diagnostics]
			: diagnostics.filter((diagnostic) => !dropped.has(diagnostic));
	return {
		body:
			kept.length === 0
				? undefined
				: formatDiagnostics(kept, "blocking").trim(),
		candidates: diagnostics.length,
		kept: kept.length,
		suppressed: dropped.size,
		unstructured: false,
	};
}
