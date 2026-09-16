---
section: Changed
---

- **Enforce the DegradationKind union against every emitted kind (refs #3071)** — a new governance sweep (`tests/config/degradation-kind-coverage.test.ts`) scans every `recordDegradationOnce` / `incrementDegradationCount` / `logDurableDegradation` call site for its `kind:` literal and fails if it is not a declared `DegradationKind` union member; `clients/degradation-ledger.ts` now declares the 15 kinds that were emitted in production without a union member (`actionable-warnings-cap`, `gitleaks_classification_timeout`, `gradle-ktlint-scan-budget-exceeded`, `instance-registry-identity-fallback`, `instance-registry-lock-timeout`, `instance-registry-registration-missing`, `lsp-document-drift`, `lsp-probe-finding-policy`, `managed-tool-install`, `pipeline-post-write-hash-unavailable`, `review-graph-memory-cap`, `review-graph-memory-cap-floor`, `sgconfig-baseline-cap-evict`, `test-runner-batch-capped`, `tree-sitter-query-parse-failed`).
