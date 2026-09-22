---
section: Fixed
---

- **Stop re-serving deleted-path-retracted blockers at turn end (closes #3190)** — #2028's deleted-path gate retracts a blocker whose cited file no longer exists from the write/edit tool result, but the turn-end inline-blocker record was still built from the raw dispatcher text, so the retracted finding came back as an authoritative "Unresolved from this turn" blocker. The record now carries the same gated set the tool result rendered: total retraction records nothing and clears the file's pending entry, partial retraction re-renders only the surviving blockers, and `inlineBlockerSources`/`inlineBlockerLines` derive from the same gated set so #1561's retirement check can never see provenance the summary dropped.