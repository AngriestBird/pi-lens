---
section: Changed
---

- **Demote `no-non-null-assertion` from warning to hint (refs #1777)** — a
  false-positive census of 49 hits across three real TypeScript codebases
  found 88% were the narrow-after-check idiom TypeScript can't itself
  verify (`map.get(k)!` after `.has(k)`, `array.pop()!` inside a
  length-guarded loop). The rule is a style opinion at opinion-density
  volume, not a bounded-precision warning; see the rule's `note:` for the
  full census.
