---
section: Fixed
audience: user
---

- **An unresolved blocker reaches the agent once per set, not on every turn that writes another file (refs #4921)** — the turn-end duplicate check keyed the turn's written-file set, so an unfixed blocker was sent again on each turn that touched a different file, and under `--lens-guard` on each repeated turn too; it now keys the delivered content, a changed or reintroduced blocker still arrives, and the commit gate keeps refusing while the blocker stands.
