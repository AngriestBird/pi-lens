---
section: Changed
audience: internal
---
- **Runner captures now record the availability probe and a real clean run.** Fixtures under `tests/fixtures/runner-output/` carry the argv, binary, and exit status their runner's availability checker receives, plus the bytes of a clean run (or the tool fact that makes one unreachable). The replay stops mocking the checker, so a tool that rejects its own probe reaches it, and the tool-state matrix's clean cell replays captured bytes instead of `""`. `scripts/capture-runner-fixtures.mjs --records-only` retrofits the records onto an existing fixture without re-recording its work bytes.
