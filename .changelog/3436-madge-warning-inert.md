---
section: Fixed
---

- **The turn-end madge pass reported a "skipped local file" count that was always zero (closes [#3436](https://github.com/apmantza/pi-lens/issues/3436))** — `buildMadgeArgs` passed `--warning`, but madge 8.0.0 gates that flag on `!program.json` (bin/cli.js) and the client always passes `--json`, so nothing reached stderr and `parseMadgeSkips` / `DepCheckResult.localSkips` could only ever return `{ total: 0, local: [] }`; ungated, the skip list prints to stdout and would corrupt the JSON this reader parses. The flag, the parser, the count field and the "possible silent cycle-miss" log line are deleted, and the lost visibility is recorded once per session/root as `madge-skip-visibility-unavailable` instead of being read as a clean graph. Pinned by a captured madge 8.0.0 invocation from a workspace with an unresolvable local import.
