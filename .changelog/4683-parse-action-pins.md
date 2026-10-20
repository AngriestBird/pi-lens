---
section: Fixed
audience: internal
---

- **`actions/setup-python` interpreter pins are parsed, not text-scanned, so no workflow shape can slip a floating version past the gate (#4683)** —
  `scripts/check-action-pins.mjs` now loads each workflow and composite action
  with `js-yaml` and walks `jobs.*.steps[]` and `runs.steps[]`, requiring a
  `python-version` that is a concrete `x.y` or `x.y.z` string, or a
  `${{ matrix.<key> }}` reference whose every matrix leg is one. Flow
  collections, anchors, aliases, tags and block scalars resolve through the
  parser instead of a scanner, and a file the parser cannot read, a step it
  cannot classify, and every other expression refuse rather than pass. The
  withdrawn text scan in #4671 found a new silent pass in each of six review
  rounds; this one has no shape to enumerate. `Action pin comments` installs
  its dependencies because the rule parses with a runtime dependency, and
  `STATE_TABLE.md`'s population lands as `tests/config/action-pin-split.test.ts`.
