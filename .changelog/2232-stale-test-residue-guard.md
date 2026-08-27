---
section: Fixed
---

- **Make a stale compiled `.js` beside a `tests/**/*.ts` file fail loudly (refs #2232)** — `tests/` is excluded from `npm run build`, so any `.js` sibling of a test-support `.ts` file is leftover residue from an earlier, differently configured local compile. Vitest's import specifiers end in `.js`, so that residue silently wins module resolution over the real source, running stale code with no warning. The build-freshness `globalSetup` now also flags this residue and aborts the run naming the file.
