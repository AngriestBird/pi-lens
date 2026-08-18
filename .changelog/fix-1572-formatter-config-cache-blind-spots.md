---
section: Fixed
---

- **Formatter config-file cache now sees files created mid-session, for several formatters that previously missed it (refs #1572)** — the per-cwd formatter cache invalidates when a tracked config file's mtime/size changes, but `psscriptanalyzer-format`'s settings file, `google-java-format`'s marker, `cljfmt`'s bare `.cljfmt`, several `cmake-format` variants, sqlfluff's `setup.cfg`, oxfmt's `vite-plus.json`/extra `vite.config` extensions, and the Kotlin/Spotless gradle files were never in the tracked list — so adding one of them to a project after pi-lens had already looked at that directory kept returning the stale, pre-opt-in answer for the rest of the session. All are now tracked.
