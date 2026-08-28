---
section: Fixed
---

- **Bound retained FactStore content bytes (closes #2247)** — file-fact stores now evict least-recently-used records after retaining 64 MiB of UTF-8 `file.content`, as well as after 1,024 records. In-flight dispatch records remain pinned until settlement, and capacity degradation records identify whether count or bytes triggered eviction.
