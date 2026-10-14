---
section: Changed
audience: internal
---

- **Cache the nightly smokes' tool installs and prune the Actions cache (#4358)** — tool-smoke and parser-smoke restore their managed tool tree from a cache keyed on the installer registry's pins and the ISO week, the other smoke workflows cache npm, a nightly `cache-prune.yml` removes caches of closed pull requests and superseded copies, and a config test fails a `pull_request_target` or `workflow_run` workflow that restores or saves a cache.
