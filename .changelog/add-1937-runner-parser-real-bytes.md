---
section: Added
---

- **Runner parsers are now held to real binary output (refs #1937)** — a parser written from documentation can be wrong in a way no hand-authored test sees, because the test asserts the same imagined shape. Captured real-bytes fixtures now live in `tests/fixtures/runner-output/`, each with a machine-generated provenance header naming the tool, version, and exact command; a replay suite feeds those bytes through the runner and fails when the parser finds nothing. The sweep found three live instances of the shape: taplo spawned a `--output=json` flag taplo rejects, stylelint read stdout while stylelint 16+ reports on stderr, and phpstan read the error COUNT as if it were the error array. All three reported clean files. A scheduled `parser-smoke` lane now runs the tier-1 tools' real binaries over a planted violation on the same assertion.
