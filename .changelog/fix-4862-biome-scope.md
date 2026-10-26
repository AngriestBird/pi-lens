---
section: Fixed
audience: user
---

- **Deferred Biome fixes cover every edited JS/TS file (#4862)** — Fix all edited files in a project at agent end instead of only the first. Keep Dart project deduplication and record duplicate-scope skips once per tool/scope per session.
