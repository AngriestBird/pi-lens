---
section: Changed
audience: internal
---

- TLA+: `formal/lsp-diagnostics-freshness/DependencyAnswer.tla` gains a `Clear` action (`clearDiagnosticsForPath` mid-wait) and the invariant `SettleNeedsAnswer`, so the `answerStored` guard of #4785 F4 is checked instead of vacuous; `DependencyMutAnswerGuard` violates it, `DependencyMutAnswerGuardNoClear` shows it passing without the clear action (refs #4782).
