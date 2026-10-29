---
section: Fixed
audience: user
---

- **LSP sees outside disk changes before `lsp_diagnostics` answers; a new subdirectory marker roots it (refs #4532)** — the look that reports a declaration, config or install change walked at most once every `PI_LENS_DECLARATION_LOOK_MS` (2 s), so a `.d.ts`/`.pyi`, a server config or an install made inside that window reached no server before the answer; the diagnostics answer now runs that look itself, with a forced walk (16 ms on a 688-directory repository, 0.12 ms on a small one). Separately, the project-boundary verdict was cached for the client registry's life, negatives included, so a marker created in a subdirectory after the parent's client answered never rooted it (real pyright 1.1.414: stale through 40 calls over 20.25 s); the verdict is now read from the disk on every resolution, and a deleted marker un-roots the directory again.
