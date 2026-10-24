---
section: Changed
audience: internal
---

- TLA+: `formal/lsp-diagnostics-freshness/DependencyAnswer.tla` gains a `Clear` action (`clearDiagnosticsForPath` mid-wait) and the invariants `SettleNeedsAnswer` and `NoDroppedAnswer`, so the `answerStored` guard of #4785 F4 is checked in both directions instead of vacuous; `DependencyMutAnswerGuard` and `DependencyMutDropAnswer` violate them, and two blindness configs show the older checks pass without them (refs #4782).
