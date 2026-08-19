---
section: Fixed
---

- **A blocking secrets finding can no longer be silenced by a loosely-matched mark (refs [#1617](https://github.com/apmantza/pi-lens/issues/1617))** — the disposition filter added for the secrets/security lanes let a WEAK-anchored suppress or defer (matched on file/tool/rule/message, no line content) drop a `"blocking"`-tier finding. Two distinct secrets sharing one gitleaks rule — two different AWS keys, say — collapsed onto the same weak anchor, so marking one false-positive silenced both. A blocking finding now drops only via the STRICT, content-bound false-positive anchor; a weak suppress or defer never touches it, in the dispatch filter, the cache-only instant filter, and the session-wide defer set alike. The suppressed-count trace (`lens_diagnostics mode=full` and turn_end) now also breaks its total down per analyzer ("gitleaks 2, knip 1"), and a per-project defer can no longer bleed into an unrelated project sharing the same relative file path.
