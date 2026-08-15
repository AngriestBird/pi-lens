---
section: Fixed
---

- **Keep the tool list stable across forks and reloads (closes #1453)** — When a session is forked, reloaded, or resumed, pi tells the model about every pi-lens tool again. Pi-lens now puts the list straight back to what it was, including the situational tools the model had activated, so the tool list the model sees does not change and your cached prompt still applies. Use `--no-lazy-tools` (or `tools.lazy: false`) to keep every tool active from the start instead.
