import { describe, expect, it } from "vitest";
import { ALL_FORMATTERS } from "../../clients/formatters.ts";
import {
	AUTO_INSTALLABLE_DEFAULT_FORMATTERS,
	FORMATTER_POLICY_BY_EXTENSION,
	FORMATTER_POLICY_BY_FILENAME,
} from "../../clients/tool-policy.ts";

// Bidirectional drift guard binding the two hand-maintained INVERSE mappings of
// the formatter↔extension relation (#1135, the #883/#209 single-source-of-truth
// class):
//   - clients/formatters.ts    : ALL_FORMATTERS[].{extensions,filenames}  (formatter → extensions)
//   - clients/tool-policy.ts   : FORMATTER_POLICY_BY_EXTENSION            (extension → formatterNames)
//
// Without this test the two lists drift silently, in either direction:
//   (1) a formatter definition gains an extension that a gating policy omits →
//       the formatter is never OFFERED for that extension (exactly #1134's
//       oxfmt/.svelte symptom, generalized to every formatter);
//   (2) a policy names a formatter for an extension the formatter's definition
//       doesn't claim → a broken option is offered.
//
// A structural derive (tool-policy.ts importing ALL_FORMATTERS to build the
// candidate lists) was rejected: formatters.ts already imports tool-policy.ts,
// so the reverse edge would create a module import cycle. This test-based guard
// keeps the dependency one-way while still binding both directions — the test is
// a leaf that may import both modules with no cycle. See #1135 for the reasoning.

const formatterByName = new Map(ALL_FORMATTERS.map((f) => [f.name, f]));
const extensionsOf = (name: string): ReadonlySet<string> =>
	new Set(formatterByName.get(name)?.extensions ?? []);

// DELIBERATE per-extension policy decisions: the formatter's definition declares
// it CAN handle the extension, but the policy intentionally routes that
// extension to a different formatter and excludes it. These must stay VISIBLE
// (an implicit silent gap is the bug this guard exists to prevent). Keyed
// "formatterName|.ext". Adding a member here is a conscious policy choice.
const DELIBERATE_POLICY_EXCLUSIONS = new Set<string>([
	// HTML: prettier (+ oxfmt) own it; biome's HTML formatter is experimental and
	// intentionally not offered.
	"biome|.html",
	"biome|.htm",
	// Vue SFC: prettier (+ oxfmt) own it; biome only formats <script> blocks.
	"biome|.vue",
	// Svelte: oxfmt is the sole svelte formatter by policy (#1134); both biome and
	// prettier declare .svelte support but are deliberately excluded.
	"biome|.svelte",
	"prettier|.svelte",
]);

// Extensions a formatter definition claims that intentionally have NO
// FORMATTER_POLICY_BY_EXTENSION entry. For these, getFormattersForFile falls
// back to the no-policy detect path (all matching formatters become candidates),
// so nothing is silently dropped. Ruby (rubocop/standardrb) and SQL (sqlfluff)
// are lint-autofix formatters whose selection is driven by detect(), not a
// smart-default policy. Any NEW formatter extension that lands without a policy
// entry must be added here CONSCIOUSLY (or gain a policy) — otherwise this guard
// fails, forcing the author to decide rather than drift.
const NO_POLICY_FALLBACK_EXTS = new Set<string>([
	".sql", // sqlfluff
	".rb", // rubocop / standardrb
	".rake", // rubocop / standardrb
	".gemspec", // rubocop
	".ru", // rubocop
]);

describe("formatter ↔ policy consistency (#1135)", () => {
	it("every formatter definition extension is either policy-included, a documented exclusion, or a documented no-policy fallback (direction 1: no silent drop)", () => {
		const violations: string[] = [];
		for (const formatter of ALL_FORMATTERS) {
			for (const ext of formatter.extensions) {
				const policy = FORMATTER_POLICY_BY_EXTENSION.get(ext);
				if (!policy) {
					// No policy entry → offered via the no-policy fallback path. Must be
					// a consciously documented fallback extension.
					if (!NO_POLICY_FALLBACK_EXTS.has(ext)) {
						violations.push(
							`${formatter.name} claims ${ext} but there is NO formatter policy for ${ext} and it is not in NO_POLICY_FALLBACK_EXTS (add a policy entry or document the fallback)`,
						);
					}
					continue;
				}
				// A policy with a non-empty candidate list GATES selection to those
				// names. If the formatter isn't among them, the extension is silently
				// dropped for that formatter — unless it's a deliberate exclusion.
				if (
					policy.formatterNames.length > 0 &&
					!policy.formatterNames.includes(formatter.name) &&
					!DELIBERATE_POLICY_EXCLUSIONS.has(`${formatter.name}|${ext}`)
				) {
					violations.push(
						`${formatter.name} claims ${ext} but the ${ext} policy [${policy.formatterNames.join(", ")}] excludes it (never offered) — add it to the policy or to DELIBERATE_POLICY_EXCLUSIONS`,
					);
				}
			}
		}
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("every extension-policy formatterName is a real formatter whose definition claims that extension (direction 2: no broken option)", () => {
		const violations: string[] = [];
		for (const [ext, policy] of FORMATTER_POLICY_BY_EXTENSION) {
			for (const name of policy.formatterNames) {
				const formatter = formatterByName.get(name);
				if (!formatter) {
					violations.push(
						`policy ${ext} names "${name}" but no formatter definition exists with that name`,
					);
					continue;
				}
				if (!extensionsOf(name).has(ext)) {
					violations.push(
						`policy ${ext} names "${name}" but ${name}'s definition does not claim ${ext} (broken option)`,
					);
				}
			}
		}
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("every policy defaultFormatter maps to a real formatter definition (extension + filename policies; #1135 comment: terragrunt-hcl)", () => {
		const violations: string[] = [];
		for (const [ext, policy] of FORMATTER_POLICY_BY_EXTENSION) {
			if (policy.defaultFormatter && !formatterByName.has(policy.defaultFormatter)) {
				violations.push(
					`extension policy ${ext} has defaultFormatter "${policy.defaultFormatter}" with no formatter definition`,
				);
			}
		}
		for (const [filename, policy] of FORMATTER_POLICY_BY_FILENAME) {
			if (policy.defaultFormatter && !formatterByName.has(policy.defaultFormatter)) {
				violations.push(
					`filename policy ${filename} has defaultFormatter "${policy.defaultFormatter}" with no formatter definition`,
				);
			}
		}
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("every filename-policy formatterName is a real formatter whose definition claims that filename (terragrunt.hcl class)", () => {
		const violations: string[] = [];
		for (const [filename, policy] of FORMATTER_POLICY_BY_FILENAME) {
			for (const name of policy.formatterNames) {
				const formatter = formatterByName.get(name);
				if (!formatter) {
					violations.push(
						`filename policy ${filename} names "${name}" but no formatter definition exists with that name`,
					);
					continue;
				}
				const claimed = (formatter.filenames ?? []).map((f) => f.toLowerCase());
				if (!claimed.includes(filename.toLowerCase())) {
					violations.push(
						`filename policy ${filename} names "${name}" but ${name}'s definition does not claim filename ${filename}`,
					);
				}
			}
		}
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("every AUTO_INSTALLABLE_DEFAULT_FORMATTERS key is a real formatter definition (sibling drift, #1086)", () => {
		// Keys are formatter names consumed by getAutoInstallToolIdForFormatter
		// (via formatter.name); a rename in formatters.ts that misses this map
		// silently disables auto-install for that formatter.
		const violations: string[] = [];
		for (const name of AUTO_INSTALLABLE_DEFAULT_FORMATTERS.keys()) {
			if (!formatterByName.has(name)) {
				violations.push(
					`AUTO_INSTALLABLE_DEFAULT_FORMATTERS names "${name}" with no formatter definition`,
				);
			}
		}
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("NO_POLICY_FALLBACK_EXTS lists exactly the definition extensions that lack a policy (keeps the allowlist honest)", () => {
		// If a fallback extension GAINS a policy (or a listed ext no longer belongs
		// to any formatter), this fails so the allowlist can't rot into a blanket
		// escape hatch.
		const actualNoPolicy = new Set<string>();
		for (const formatter of ALL_FORMATTERS) {
			for (const ext of formatter.extensions) {
				if (!FORMATTER_POLICY_BY_EXTENSION.has(ext)) actualNoPolicy.add(ext);
			}
		}
		expect([...actualNoPolicy].sort()).toEqual([...NO_POLICY_FALLBACK_EXTS].sort());
	});
});
