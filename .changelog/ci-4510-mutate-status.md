---
section: Fixed
audience: internal
---

- **`scripts/mutate.mjs` prints REFUSED for a refused edit and BROKEN for a failed build (#4510)** — the mutation transcript and table row used to print `RED` for any thrown error, so a mutation that never ran read as a test that catches it. `RED` now means a test run failed, `REFUSED` a no-op or comment-only edit, `BROKEN` a failed build, and `ERROR` any other failure without a verdict, including a vitest killed from outside and a `--tests` path with no test file. A signal to the run now kills vitest's whole process group, so its worker fork no longer keeps spinning. Exit codes are unchanged. Pinned by the REFUSED, BROKEN, ERROR and signal cases in `tests/scripts/mutate.test.ts`.
