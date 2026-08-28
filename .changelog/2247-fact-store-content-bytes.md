---
section: Fixed
---

- **Bound retained FactStore content bytes (closes #2247)** — file-fact stores now evict least-recently-used records after retaining 64 MiB of UTF-8 `file.content`, as well as after 1,024 records. In-flight dispatch records remain pinned until settlement. A count-axis and a byte-axis eviction on the same store each get their own degradation record instead of sharing one dedupe key, and a pin whose content alone exceeds the byte budget stops evicting unpinned inserts instead of silently discarding every one of them, recording that state through its own degradation kind.
