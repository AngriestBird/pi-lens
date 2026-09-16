---
section: Fixed
---

- **Exclude template-literal interiors from the formatter's indentation fallback (closes #3059)** — a multi-line template literal's interior lines (a help-text string, say) were still counted as indentation evidence after #3039 excluded block-comment interiors for the same alignment-not-nesting shape, so a 4-space file whose template literal happened to be 2-space indented got re-indented to 2 on its first format. `indent-detect.ts` now excludes template interiors with the same lexical discipline as the block-comment rule, tracking `${ … }` nesting and escaped backticks so neither closes the tracked template early.
