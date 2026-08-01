/**
 * Normalize a rule id to the form a user typically writes in a
 * `pi-lens-ignore` comment, an inline suppression, or a project-level
 * `disable`/`select` list. Strips the `ast-grep:` LSP source prefix and the
 * `-js` language suffix — the same forms `tools/lens-diagnostics.ts`'s
 * `normalizeRuleForDedup` already collapsed across the LSP/napi surfaces so a
 * single user-facing id (`no-eval`) catches every variant
 * (`ast-grep:no-eval`, `no-eval`, `no-eval-js`).
 *
 * Shared by `clients/dispatch/inline-suppressions.ts` and
 * `clients/dispatch/rule-policy.ts` (and previously duplicated in `tools/lens-
 * diagnostics.ts`); consolidated here so the three surfaces can never drift.
 */

export function normalizeRuleId(ruleId: string): string {
	return ruleId.replace(/^ast-grep:/, "").replace(/-js$/, "");
}

/**
 * Back-compat alias for the dedup normalizer that lived in
 * `tools/lens-diagnostics.ts`. Kept identical (same strip pipeline) so the
 * two normalizations round-trip identically and the shared module can stand
 * in for either without behavior change.
 */
export function normalizeRuleForDedup(ruleId: string): string {
	return normalizeRuleId(ruleId);
}
