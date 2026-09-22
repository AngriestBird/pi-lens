/**
 * The ONE filter stack a findings surface applies before a diagnostic reaches
 * the agent: inline `pi-lens-ignore` comments (#442), stored dispositions
 * (#690 — false-positive/suppress/defer), and the project's `.pi-lens.json`
 * `rules.<id>.disable`/`select` policy, in that order.
 *
 * The order is load-bearing and is the one the per-edit dispatcher established:
 * inline suppression first (the user's in-file intent), then the stored marks,
 * then the project policy — so the policy filter sees the same set the per-edit
 * path produces, with no double counting and no policy-rejected leftovers.
 *
 * #3088: these were three separate calls open-coded in `lens-diagnostics.ts`'s
 * `mode=full` merge and nothing at all on the `lens_diagnostics source=lsp` /
 * `lsp_diagnostics` probe lane — so a finding an agent had marked
 * `false-positive` was hidden in `mode=delta`/`mode=full` and re-reported on
 * the lane `skills/pi-lens-lsp-navigation` steers agents to as PRIMARY. Both
 * lanes call this module now: `applyFindingPolicy` for surfaces that already
 * hold dispatch `Diagnostic`s, `applyLspFindingPolicy` for the probe lane,
 * which holds raw `LSPDiagnostic`s.
 */

import {
	applyDispositions,
	hasAnyDispositionMarks,
	type DispositionCandidate,
} from "../diagnostic-dispositions.js";
import type { FileRole } from "../file-role.js";
import type { LSPDiagnostic } from "../lsp/client.js";
import { loadPiLensProjectConfig } from "../project-lens-config.js";
import { retagAuxiliaryDiagnostics } from "./auxiliary-lsp.js";
import { applyInlineSuppressions } from "./inline-suppressions.js";
import { applyRulePolicy, rulePolicyMapFromConfig } from "./rule-policy.js";
import type { Diagnostic } from "./types.js";
import { convertLspDiagnostics } from "./utils/lsp-diagnostics.js";

/** The `(tool, rule)` pair a disposition anchor is derived from. Either half
 * may be absent — `lens_diagnostic_mark` takes both as optional. */
export interface FindingIdentity {
	tool?: string;
	rule?: string;
}

export interface FindingPolicyOptions<T> {
	cwd: string;
	filePath: string;
	/**
	 * The file's CURRENT content. `""` is the documented fail-open input (the
	 * content could not be read): inline suppression becomes a no-op and the
	 * STRICT disposition anchor hashes an empty line, so it cannot match a mark
	 * made against real content and the finding stays VISIBLE. Weak-anchored
	 * suppress/defer never look at content and keep applying either way. Never
	 * hide a finding over an I/O error (AGENTS.md shape 48).
	 */
	content: string;
	policyMap: Record<string, unknown> | undefined;
	/**
	 * Every `(tool, rule)` spelling a mark against THIS surface's rendering of
	 * the diagnostic can carry. Omit for a surface whose rendered identity IS
	 * the diagnostic's own `tool`/`rule` (dispatch, the widget, `mode=full`) —
	 * the default is exactly the behavior those surfaces already had.
	 */
	identities?: (diagnostic: T) => FindingIdentity[];
}

export interface FindingPolicyResult<T> {
	/** Survivors of the whole stack — what the surface renders. */
	kept: T[];
	/**
	 * Survivors of the CONTENT-derived step alone (inline `pi-lens-ignore`).
	 * A content-keyed cache records THIS, not `kept`: an inline comment cannot
	 * change without invalidating the entry, while a disposition mark and a
	 * `.pi-lens.json` rule can be revoked at any moment — caching their effect
	 * would keep a finding hidden long after its mark was removed.
	 */
	inlineKept: T[];
}

/**
 * Inline suppression → stored dispositions → project rule policy, over
 * diagnostics that already carry dispatch identity (`tool`/`rule`/`line`).
 */
export function applyFindingPolicy<
	T extends DispositionCandidate & {
		rule?: string;
		code?: string;
		id?: string;
	},
>(diagnostics: T[], options: FindingPolicyOptions<T>): FindingPolicyResult<T> {
	const inlineKept = applyInlineSuppressions(diagnostics, options.content);
	const disposed = filterDisposed(inlineKept, options);
	return { kept: applyRulePolicy(disposed, options.policyMap), inlineKept };
}

/** The project's `.pi-lens.json` `rules.<id>.disable`/`select` policy map.
 * One derivation for every surface that filters by it — `loadPiLensProjectConfig`
 * is mtime-cached, so repeated calls in one sweep cost one stat. */
export function loadProjectRulePolicyMap(
	cwd: string,
): ReturnType<typeof rulePolicyMapFromConfig> {
	return rulePolicyMapFromConfig(loadPiLensProjectConfig(cwd).rules);
}

/**
 * Disposition filter over the candidate identities a mark can carry.
 *
 * With no `identities` provider this is `applyDispositions` on the diagnostics
 * themselves — one anchor pair per diagnostic, the behavior every existing
 * caller has. With one, the SAME `applyDispositions` runs over the flattened
 * candidate list — no second strict/weak implementation to drift away from it
 * (#1617's single-source rule) — and a diagnostic drops when ANY of its
 * candidate identities was disposed.
 */
function filterDisposed<T extends DispositionCandidate>(
	diagnostics: T[],
	options: FindingPolicyOptions<T>,
): T[] {
	const identities = options.identities;
	if (!identities) {
		return applyDispositions(
			diagnostics,
			options.cwd,
			options.filePath,
			options.content,
		);
	}
	// Same zero-I/O hoist the cache-only modes use (#1625 F2): with no marks at
	// all there is nothing a candidate expansion could match, so the probe lane
	// pays no per-finding allocation for the overwhelmingly common empty store.
	if (!diagnostics.length || !hasAnyDispositionMarks(options.cwd)) {
		return diagnostics;
	}
	const expanded = diagnostics.flatMap((diagnostic) =>
		identities(diagnostic).map((identity) => ({
			diagnostic,
			candidate: {
				...identity,
				message: diagnostic.message,
				...(diagnostic.line !== undefined && { line: diagnostic.line }),
				...(diagnostic.semantic !== undefined && {
					semantic: diagnostic.semantic,
				}),
			} satisfies DispositionCandidate,
		})),
	);
	const survivors = new Set(
		applyDispositions(
			expanded.map((entry) => entry.candidate),
			options.cwd,
			options.filePath,
			options.content,
		),
	);
	const disposed = new Set<T>();
	for (const entry of expanded) {
		if (!survivors.has(entry.candidate)) disposed.add(entry.diagnostic);
	}
	return disposed.size === 0
		? diagnostics
		: diagnostics.filter((diagnostic) => !disposed.has(diagnostic));
}

/**
 * #3088 / AGENTS.md shape 26: the identity spellings a mark against a probe
 * finding can carry, derived from the surfaces that RENDER it rather than
 * guessed:
 *
 *  - `convertLspDiagnostics` + `retagAuxiliaryDiagnostics` — the canonical
 *    dispatch identity (`tool: "lsp"`, or the auxiliary's own id, and
 *    `rule: "<source>:<code>"`). This is what the widget footer, `mode=delta`
 *    and `mode=full` render, so it is the spelling of a mark made anywhere
 *    else in the session.
 *  - `formatDiag` in `tools/lsp-diagnostics.ts` — the probe's OWN text render
 *    is `[<source>] (<code>)`, so a mark made from THIS lane's output carries
 *    `tool: "<source>"`, `rule: "<code>"`.
 *
 * plus, for each, the form with `tool` omitted: `lens_diagnostic_mark`'s
 * `tool` parameter is optional and #3088's own reproduction omits it. A
 * single-spelling filter honors a mark made on one surface while re-reporting
 * the same finding when the mark was made on the other, which is exactly the
 * non-convergence #3088 reported.
 */
function probeIdentities(
	canonical: DispositionCandidate,
	raw: LSPDiagnostic | undefined,
): FindingIdentity[] {
	const rendered: Array<[string | undefined, string | undefined]> = [
		[canonical.tool, canonical.rule],
	];
	if (
		raw !== undefined &&
		(raw.source !== undefined || raw.code !== undefined)
	) {
		rendered.push([
			raw.source,
			raw.code === undefined ? undefined : String(raw.code),
		]);
	}
	return expandRenderedIdentities(rendered);
}

/**
 * #3102: the identity spellings a mark against a surface that renders a
 * finding's RULE but never its TOOL can carry — the turn-end late-auxiliary
 * advisory (`<file>:<line>:<col> [<rule>] <message>`) and the cold-neighbour
 * cascade run (`line N, col M rule=<rule>: <message>`). Both print the
 * canonical dispatch `rule`, so a mark made ELSEWHERE (the widget, `mode=full`)
 * carries the full `(tool, rule)` pair while a mark made from the surface's own
 * output has no tool to pass on — and `lens_diagnostic_mark`'s `tool` parameter
 * is optional. Honoring only one of the two spellings is exactly the
 * non-convergence #3088 reported, so both go through the SAME expansion
 * `probeIdentities` uses.
 */
export function renderedRuleIdentities(diagnostic: {
	tool?: string;
	rule?: string;
}): FindingIdentity[] {
	return expandRenderedIdentities([[diagnostic.tool, diagnostic.rule]]);
}

/**
 * #3246: the identity spellings a mark against a surface that renders NEITHER
 * the tool NOR the rule can carry — the turn-end unresolved-inline-blocker
 * body, whose every line is `formatDiagnostics`' `  L<n>: <message>` (plus an
 * optional fix hint). An agent marking from that text has only the message and
 * the line to give `lens_diagnostic_mark`, whose `tool` AND `rule` parameters
 * are both optional, so the mark's anchor carries neither; a mark made from the
 * widget or `mode=full` carries the full canonical pair for the same finding.
 * Honoring one spelling and not the other is exactly the non-convergence #3088
 * reported, so both go through the SAME expansion `probeIdentities` uses. The
 * bare spelling stays safe for this STOP-tier surface because a `"blocking"`
 * diagnostic can only ever be dropped by the STRICT, content-bound
 * false-positive anchor (`applyDispositions`' F1 rule), which still binds the
 * normalized message and the flagged line's content hash.
 */
export function inlineBlockerIdentities(diagnostic: {
	tool?: string;
	rule?: string;
}): FindingIdentity[] {
	return expandRenderedIdentities([
		[diagnostic.tool, diagnostic.rule],
		[undefined, undefined],
	]);
}

/** Every rendered `(tool, rule)` spelling plus the `tool`-omitted form of
 * each, de-duplicated, in order. One derivation for both callers. */
function expandRenderedIdentities(
	rendered: Array<[string | undefined, string | undefined]>,
): FindingIdentity[] {
	const out: FindingIdentity[] = [];
	const seen = new Set<string>();
	for (const [tool, rule] of rendered) {
		// Both spellings also in the `tool`-omitted form the mark tool admits.
		for (const candidateTool of [tool, undefined]) {
			const key = `${candidateTool ?? ""}\u0000${rule ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				...(candidateTool !== undefined && { tool: candidateTool }),
				...(rule !== undefined && { rule }),
			});
		}
	}
	return out;
}

export interface LspFindingPolicyResult {
	/** The surviving raw diagnostics, in input order. */
	kept: LSPDiagnostic[];
	/** Survivors of inline suppression alone — what a content-keyed cache
	 * records; see `FindingPolicyResult.inlineKept`. */
	inlineKept: LSPDiagnostic[];
}

/* No drop COUNT is returned here on purpose (round 2 F1): the number an agent
 * is shown has to be scoped to that caller's severity threshold, and this
 * module must not learn about a threshold its other caller (`mode=full`) does
 * not have. `kept` versus the input is all a caller needs to derive its own. */

/**
 * The probe lane's entry point: the same stack, over RAW LSP diagnostics.
 *
 * Identity comes from the two shared converters the widget footer already runs
 * on this very path (`convertLspDiagnostics` + `retagAuxiliaryDiagnostics`),
 * never a third derivation — a second copy of the conversion giving the same
 * finding a different `rule`, and orphaning every mark against it, is the #692
 * defect itself.
 *
 * `retagAuxiliaryDiagnostics` is used for its in-place re-tag only; its own
 * drop set (native aux comments, `skipTestFiles`) is deliberately ignored here
 * because `applyAuxiliarySuppressions` already applied exactly that filter to
 * these diagnostics at collection time — re-dropping would double-apply a
 * filter this route owns upstream.
 */
export function applyLspFindingPolicy(
	diagnostics: LSPDiagnostic[],
	options: {
		cwd: string;
		filePath: string;
		/** `undefined` when the content could not be read — see `content` above. */
		content: string | undefined;
		policyMap: Record<string, unknown> | undefined;
		fileRole: FileRole;
	},
): LspFindingPolicyResult {
	if (!diagnostics.length)
		return { kept: diagnostics, inlineKept: diagnostics };
	const content = options.content ?? "";
	// `convertLspDiagnostics` drops entries with no start line, which would
	// break the 1:1 index alignment `retagAuxiliaryDiagnostics` and the map-back
	// below depend on. Partition first so the converted array IS aligned with
	// `anchored`; a line-less entry passes straight through (it carries no line
	// for an anchor to bind to, and dropping it would silently lose a finding
	// this filter has no claim over).
	const anchored: LSPDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		if (diagnostic.range?.start?.line !== undefined) anchored.push(diagnostic);
	}
	if (!anchored.length) return { kept: diagnostics, inlineKept: diagnostics };
	const converted = convertLspDiagnostics(anchored, options.filePath);
	retagAuxiliaryDiagnostics(converted, anchored, content, {
		cwd: options.cwd,
		fileRole: options.fileRole,
	});
	// `convertLspDiagnostics` maps its (pre-filtered) input 1:1, so `converted[i]`
	// belongs to `anchored[i]`. Pair them up front and work from the pairing: a
	// converted entry with no counterpart is simply never paired, so it can never
	// be dropped — fail open, never hide a finding this filter could not identify.
	const rawByConverted = new Map<Diagnostic, LSPDiagnostic>();
	for (const [index, diagnostic] of converted.entries()) {
		const raw = anchored[index];
		if (raw !== undefined) rawByConverted.set(diagnostic, raw);
	}
	const { kept, inlineKept } = applyFindingPolicy(converted, {
		cwd: options.cwd,
		filePath: options.filePath,
		content,
		policyMap: options.policyMap,
		identities: (diagnostic) =>
			probeIdentities(diagnostic, rawByConverted.get(diagnostic)),
	});
	const survivorsOf = (survivors: Diagnostic[]): LSPDiagnostic[] => {
		if (survivors.length === converted.length) return diagnostics;
		const keptConverted = new Set(survivors);
		const dropped = new Set<LSPDiagnostic>();
		for (const [diagnostic, raw] of rawByConverted) {
			if (!keptConverted.has(diagnostic)) dropped.add(raw);
		}
		return diagnostics.filter((d) => !dropped.has(d));
	};
	return { kept: survivorsOf(kept), inlineKept: survivorsOf(inlineKept) };
}
