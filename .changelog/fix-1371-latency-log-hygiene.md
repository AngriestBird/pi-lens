---
section: Fixed
---

- **Latency-log hygiene (closes #1371)** — Ast-grep unsupported-language telemetry now dedupes per language for each session and emits only a bounded rule-ID sample; the log analyzer excludes synthetic temp/scratchpad/heap-corpus rows by default, supports repeatable `--exclude` globs, and reports excluded-row counts.
