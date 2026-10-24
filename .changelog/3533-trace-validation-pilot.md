---
section: Added
audience: internal
---

- **Trace validation pilot for the session-lifecycle model.** A real lifecycle run's `session_scope_transition` rows are checked against `formal/session-lifecycle` with TLC (`scripts/trace-validate-session-lifecycle.mjs`); the design note, the measured cost and the planted-drift reds are in `docs/adr/0010-trace-validation-session-lifecycle.md` (#3533).
