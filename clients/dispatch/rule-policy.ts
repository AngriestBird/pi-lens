/**
 * Project-level rule policy (`.pi-lens.json` `rules.<id>.disable` /
 * `rules.<id>.select`) — output-only filtering of dispatches, so the project's
 * own policy narrows what the user actually sees without widening the trusted
 * surface area (widget state, baseline, dedup, and per-edit record stay
 * authoritative).
 *
 * Matching is PROJECT-WIDE. The outer `rules.<key>` is a grouping label only —
 * it does not scope which diagnostics a `disable`/`select` list under it can
 * match. Every `disable` entry across every key is unioned into one drop list,
 * and every `select` entry across every key is unioned into one allowlist.
 * Disable is checked first, so it wins globally regardless of which key it's
 * configured under.
 *
 * Match normalization is consolidated with the rest of the rule-id surfaces:
 * `inline-suppressions.ts` and `lens-diagnostics.ts`'s `normalizeRuleForDedup`
 * both strip the `ast-grep:` prefix and the `-js` suffix, so a user listing
 * `no-eval` once under `disable` covers both the LSP tag (`ast-grep:no-eval`)
 * and the napi tag (`no-eval` / `no-eval-js`). Sharing the normalization keeps
 * the three surfaces from drifting.
 */
import { normalizeRuleForDedup } from "./rule-id-normalize.js";

export interface RulePolicyEntry {
	disable?: string[];
	select?: string[];
}

/**
 * A project's rule-config-key -> policy map (the same shape
 * `PiLensProjectConfig.rules` already uses for `threshold`). The key is only
 * a grouping label (e.g. `"security"`, `"my-rule-set"`) — it does not scope
 * matching, which is project-wide across every key's `disable`/`select`
 * lists (see the module doc comment). `Partial<>` so a threshold-only entry
 * passes the type checker even though only `disable`/`select` are consulted
 * at filter time.
 */
export type RulePolicyMap = Record<string, RulePolicyEntry | undefined>;

/**
 * Decide whether a rule id (in the form it's emitted on a diagnostic — e.g.
 * `ast-grep:no-eval`, `no-eval-js`, `no-eval`, `ts:2322`) should be filtered
 * out under a project's rule policy map. Returns `dropped: true` when the
 * diagnostic would be hidden from output.
 *
 * Project-wide: every `disable` entry across every configured key is checked
 * first (disable wins globally over select). Then every `select` entry
 * across every key is unioned into one allowlist — a non-empty union that
 * the rule doesn't match also drops it. An absent/empty union across all
 * keys means "no restriction". Matching uses the same normalization as
 * inline suppression so a configured `no-eval` entry covers
 * `ast-grep:no-eval` and `no-eval-js`.
 */
export function evaluateRulePolicy(
	ruleId: string,
	policyMap: RulePolicyMap | undefined,
): { dropped: boolean } {
	if (!policyMap) return { dropped: false };
	const raw = ruleId || "";
	const norm = normalizeRuleForDedup(raw);

	for (const entry of Object.values(policyMap)) {
		if (!entry) continue;
		for (const d of entry.disable ?? []) {
			if (matchesRule(d, raw, norm)) return { dropped: true };
		}
	}

	let hasSelect = false;
	for (const entry of Object.values(policyMap)) {
		if (!entry) continue;
		for (const s of entry.select ?? []) {
			hasSelect = true;
			if (matchesRule(s, raw, norm)) return { dropped: false };
		}
	}
	return { dropped: hasSelect };
}

function matchesRule(entry: string, raw: string, normalized: string): boolean {
	if (entry === raw) return true;
	return normalizeRuleForDedup(entry) === normalized;
}

/**
 * Filter an array of diagnostics (returns a new array) by the project rule
 * policy map. Only `rule` is consulted: `Diagnostic.id` is a dedup key
 * (`eslint:unknown:12`), not a rule id, so measuring it against a project-wide
 * `select` allowlist would silently drop every rule-less finding, including
 * blocking ones like an eslint parse error. A diagnostic with no `rule` has
 * nothing to match on and is kept untouched.
 *
 * Used by both the per-edit dispatcher and the `lens-diagnostics` tool's
 * `mode=delta`/`mode=all`/`mode=full` paths so a project's own policy
 * applies consistently across every output surface.
 */
export function applyRulePolicy<T extends { rule?: string }>(
	diagnostics: T[],
	policyMap: Record<string, unknown> | undefined,
): T[] {
	if (!policyMap) return diagnostics;
	// Fast-path: if every entry has neither disable nor select, there is no
	// output filter to apply. Keeps the hot path (most projects have only
	// thresholds) cheap.
	let hasFilter = false;
	for (const rawEntry of Object.values(policyMap)) {
		if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
			continue;
		}
		const entry = rawEntry as { disable?: string[]; select?: string[] };
		if ((entry.disable?.length ?? 0) > 0 || (entry.select?.length ?? 0) > 0) {
			hasFilter = true;
			break;
		}
	}
	if (!hasFilter) return diagnostics;

	return diagnostics.filter((d) => {
		const ruleId = d.rule;
		if (!ruleId) return true;
		const { dropped } = evaluateRulePolicy(ruleId, policyMap as RulePolicyMap);
		return !dropped;
	});
}

/**
 * Build the policy map from a `PiLensProjectConfig.rules`-shaped value. Returns
 * undefined when there's nothing to filter (the hot path), or a map suitable
 * for `applyRulePolicy` otherwise. Excludes entries whose only field is
 * `threshold` (a threshold is a separate concern handled elsewhere) so the
 * filter step doesn't repeat the work.
 */
export function rulePolicyMapFromConfig(
	rules: Record<string, unknown> | undefined,
): RulePolicyMap | undefined {
	if (!rules) return undefined;
	let built: RulePolicyMap | undefined;
	for (const [key, rawEntry] of Object.entries(rules)) {
		if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
			continue;
		}
		const entry = rawEntry as { disable?: string[]; select?: string[] };
		const hasDisable = (entry.disable?.length ?? 0) > 0;
		const hasSelect = (entry.select?.length ?? 0) > 0;
		if (!hasDisable && !hasSelect) continue;
		built ??= {};
		built[key] = {
			...(hasDisable ? { disable: entry.disable } : {}),
			...(hasSelect ? { select: entry.select } : {}),
		};
	}
	return built;
}
