---
section: Changed
audience: internal
---

- **TLA+ session models cover marker expiry, the per-evaluation LSP generation, the widget token and the late coordinator stores (refs #3803)**: #3668's successor-pending marker expires (`MarkerExpire`, no clock), #3755's per-evaluation generation is caught by an owner-live invariant the generation clause could not see, the widget's `>=` tie and fork carry are pinned in both directions (`SessionLifecycleF1`), the receipt, `fixedThisTurn`, analysed-state latch and runner writers are fenced by their captured scope (#3824), and `session-straddle` retires the generation at shutdown (#3611), each with a violating pre-fix or mutant config and a passing merged one.
