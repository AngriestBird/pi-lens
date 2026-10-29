---
section: Fixed
audience: user
---

- **A subdirectory whose own project marker appears is rooted there instead of sharing its parent's server (refs #4532)** — the project-boundary verdict (does this directory own a `package.json`/`pyproject.toml`/…, or is it a config-only directory that shares the ancestor's client?) was cached for the client registry's life, negatives included, so a marker created in a subdirectory after the parent's client answered never rooted it: its own `pyrightconfig.json` reached no server and no client was hosted there (real pyright 1.1.414: stale through 40 calls over 20.25 s). The verdict is read from the disk on every resolution, and a deleted marker un-roots the directory again.
