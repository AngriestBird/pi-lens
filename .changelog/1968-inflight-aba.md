---
section: Fixed
---

- **Identity-guard seven more in-flight promise caches against ABA eviction (refs #1968)** — `SecurityScanClient.dedupeScan` (gitleaks/trivy/govulncheck), `JscpdClient`, `DependencyChecker`'s per-file and per-project caches, the MCP Stop-hook's `runTurnEndForIpc`, `initLSPConfig`, and `ensureTool`'s per-tool install map all cleared their in-flight entry with a bare delete-by-key, same shape as the dead-code/knip sites #1968 already fixed. A late-settling run could evict a live successor a second writer registered under the same key, causing the next caller to start a duplicate scan/check/install. All seven now delete only when the map still holds their own promise. One sibling, `ast-grep`'s shared availability probe (`runner-helpers.ts`), was reachable TODAY (not latent): a session-boundary reset is itself the second writer, so the bug could fire in production, not only after a future code change.
