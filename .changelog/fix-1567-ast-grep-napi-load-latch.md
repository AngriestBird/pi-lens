---
section: Fixed
---

- **The ast-grep native-addon load no longer races or latches across sessions (refs [#1567](https://github.com/apmantza/pi-lens/issues/1567))** — `loadSg()` guarded the `@ast-grep/napi` load behind a plain "attempted" flag: the per-edit fallback runner and the session-start project scanner both call it and could race, so a caller arriving while a load was already in flight started a second, redundant `import()` of the native addon. Any load failure then latched for the rest of the process, with no re-arm at session start. The fix shares one in-flight promise across callers, evicts it on settle so a rejected load is never replayed (the `#1536` pattern), and classifies failures: a transient failure (an FS or native-binding hiccup) retries after a bounded cooldown, while a genuine failure (the package missing, the native binding incompatible with the platform) holds for the session but re-arms at the next `session_start` via `resetAstGrepNapiLoadState()`.
