---
section: Changed
audience: internal
---

- TLA+: `formal/lsp-diagnostics-freshness/DependencyAnswer.tla` gains a `Clear` action (`clearDiagnosticsForPath` mid-wait) and the invariants `SettleNeedsAnswer`, `NoDroppedAnswer` and `NoCanceledStored`, so the `answerStored` guard of #4785 F4 and the slot cancel are checked instead of vacuous; hand-mutant configs violate each invariant, and blindness configs show the older checks pass those mutants (refs #4782).
