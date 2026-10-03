---
section: Fixed
audience: internal
---

- **Governance occurrence identity no longer drifts at the 400-line owner bound (refs #3938)** — `findEnclosingSymbol` derives the nearest enclosing declaration from a request-local per-file pass instead of a 400-line window, so inserting harmless lines above a flagged await no longer drops the symbol component from its exemption key. The hook-await registries were re-keyed with same-file, same-own-hash, same-context proof.
