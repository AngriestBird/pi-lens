---
section: Changed
audience: internal
---

- The bounded-eviction idiom sweep (`tests/config/bounded-eviction-idiom-sweep.test.ts`) now matches the iterator-result spelling (`const oldest = m.keys().next()` with `.value` read on a later line), the one the pre-#4503 drift cap used and all four earlier spellings missed, and it matches it on the semantic rather than on an accessor name. The five production sites the wider matcher found (`clients/cascade-format.ts`, `clients/lsp/cascade-tier.ts`, `clients/mcp/session.ts`, `clients/read-guard.ts`, `clients/test-runner-delivery.ts`) move their cap into `BoundedFifoMap` instead of hand-rolling the evict-oldest loop; their eviction order and degradation records are unchanged. The second round widens the same sweep to an accessor chain a formatter wraps across lines, `$`-initial names, iterator destructuring, a re-assignment, a binding wrapped after `=`, and an eviction whose victim is picked by a comparator over a spread accessor: the session-fact tombstone trim moves its cap into `BoundedSet`, and six live sites whose policy no bounded class expresses are admitted with reasons. Refs #4570.
