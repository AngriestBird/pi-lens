---
section: Fixed
---

- **`language: TypeScript` ast-grep rules now run on `.tsx` files** — the napi runner compared a rule's declared language against `.tsx`'s exact grammar name (`"tsx"`), so every `TypeScript`-tagged rule's language guard skipped it on React/TSX sources, leaving 120 of 263 shipped rules dark there. Since `.tsx`'s grammar is a syntactic superset of `.ts`'s, a `TypeScript`-tagged rule now also runs against a `.tsx` file's parsed root, the same one-directional relationship the runner already applies between `.ts` and `.js`. A rule skipped purely for a language/file mismatch is now recorded in the same aggregated `astgrep_napi_unsupported_rules_skipped` latency telemetry the runner already emits for wholly-unsupported languages, so an empty result on a `.tsx` scan is distinguishable from "rules never ran" (#1608).
