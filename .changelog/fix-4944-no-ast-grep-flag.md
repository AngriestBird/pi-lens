---
section: Fixed
audience: user
---

- **`--no-ast-grep` and `astGrep.enabled=false` now switch the ast-grep server off.** The kill switch the server already read was never registered, so neither spelling existed; `lens_diagnostics mode=full` also now leaves a switched-off auxiliary server unstarted and names it, and a peer pi-lens session's findings from a switched-off server (`--no-opengrep` included) are no longer shown (refs #4944).
