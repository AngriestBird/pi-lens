---
section: Fixed
audience: internal
---

- Tests: the `tool-cwd` language-roots fixture and the bounded-container guard's probe roots no longer build under the repository root, so a repo-walking governance scan on a sibling worker cannot list them and then `ENOENT` when the cell removes them mid-walk; the shared harness records a directory a test names at that root, and the tmp-fixture hygiene owner fails the creation even after the cell removed it.
