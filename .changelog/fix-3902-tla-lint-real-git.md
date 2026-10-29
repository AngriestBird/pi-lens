---
section: Fixed
audience: internal
---

- The local PR-body lint sends its merge-base, `origin` and workflow-file git reads through the injected git, so the TLA+ coverage lint cases no longer spawn real git under a fake one and stop timing out at 5 s on a loaded runner (closes #3902, refs #4909).
