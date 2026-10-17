---
section: Added
audience: internal
---

- A `tests/config` sweep now censuses how the tree composes the `PATH`
  environment variable, because Windows' environment block is
  case-insensitive while a `ProcessEnv` object is not: a composition that
  writes both `PATH` and `Path`, or writes `PATH` over a spread that supplied
  `Path`, hands a child two names for one variable and one shadows the other
  (closes #4590). The 69 current sites — 13 in shipped code, 56 in test
  fixtures — are seeded as debt with their reason; a new site, a stale row or
  a changed reason reds.
