---
section: Changed
---

- **Gate word-index arena recompaction on a share of the vocabulary (refs #2246)** — the flat 64-store recompaction threshold was crossed by every edit, because one document replacement raises the backing-store estimate by the edited document's distinct-token count. The gate is now 10% of the live vocabulary above a 64-store floor, so fragmentation accumulates proportionally to the index. On a 2,844-document, 2.4M-posting corpus, 300 sequential edits recompact 14 times instead of 299, the per-edit cooperative block drops from mean 32.0 ms to 12.4 ms, and peak resident memory is unchanged (the recompaction share of per-edit CPU falls from 23% to 4%). Small corpora keep the pre-change behaviour: the floor governs any index whose vocabulary is under 640 tokens.
