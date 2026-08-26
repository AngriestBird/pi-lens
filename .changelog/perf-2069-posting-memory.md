---
section: Changed
---

- **Shrink the word index's resident footprint by 5.7x (refs #2069)** — Postings and the forward index now live in packed `Int32Array` lanes over a dense file-id space instead of one boxed `{ file, line }` object per posting. On pi-lens's own 2,682-document tree the index measures 32.7 MB, down from 186.6 MB, and 15.1 bytes per posting entry, down from 88.1. Search results, the persisted snapshot format, and incremental refresh behaviour are unchanged. The `full_rebuild`, `incremental_refresh`, `cold_build`, and `persist_succeeded` records in `word-index.log` gained a `residentBytes` field, and `memory_sample` gained `postingEntries` and `residentBytes`, so a heap census can be reconciled from the logs.
