---
section: Fixed
audience: user
---

- **A late dead-code scan stays with the session that started it, and a failed scan no longer replaces a good knip or dead-code baseline (closes #4154)** — A Python dead-code scan that missed the turn-end budget is now kept for the session whose turn started it: a subagent running beside the main session no longer receives the main session's late findings, and a scan that finishes after its session ended is dropped. When a turn end joins a vulture scan that was already running before its edits (after `/new`, from a subagent, or from a `lens_diagnostics` fetch), the files edited since are scanned again on the next turn, so the symbols they made unused are still reported. A knip or vulture scan that fails no longer overwrites a good baseline that another pi-lens process stored for the same project while it ran; the turn's `latency.log` row or the scan's `dead-code.log` event (whichever that site writes) says `cacheKept: true` when that happens.
