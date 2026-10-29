---
section: Fixed
audience: internal
---

- The local PR-body lint sends every git read through the injected git, and the Observability record scan skips the family token of a `TLA+ unaffected:` line, so the TLA+ coverage lint cases no longer spawn real git or lex the runtime tree and stop timing out at 5 s on a loaded runner (closes #3902, refs #4909).
