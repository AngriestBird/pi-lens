---
section: Fixed
audience: internal
---

- Tool-smoke now fails a runner whose tool was killed, timed out or rejected its invocation, instead of rendering it as a skipped tool. The skip carries the fault kind, and an absent tool still skips. A run cut short after it printed (cue-vet, gleam-check, prisma-validate, terragrunt) keeps its findings but no longer counts as a completed check, and trivy-config names a failed launch as did-not-run. (refs #4130)
