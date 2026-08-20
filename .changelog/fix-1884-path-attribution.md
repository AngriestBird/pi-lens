---
section: Fixed
---

- **Tally verified relative-path attribution guesses instead of logging one record per read (refs [#1884](https://github.com/apmantza/pi-lens/issues/1884))** — existing workspace-root guesses now increment one session counter and emit one `path_attribution_verified_rollup` latency row at shutdown; missing, ambiguous, or non-existent guesses retain the full `path_attribution_missing` record with its raw and guessed paths.
