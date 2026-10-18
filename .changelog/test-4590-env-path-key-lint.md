---
section: Added
audience: internal
---

- A `tests/config` sweep now censuses how the tree composes the `PATH`
  environment variable, because Windows' environment block is
  case-insensitive while a `ProcessEnv` object is not: a composition that
  writes both `PATH` and `Path`, or writes `PATH` over a spread that supplied
  `Path`, or `Object.assign`/`Object.fromEntries` builds one over a base,
  hands a child two names for one variable and one shadows the other
  (closes #4590). The rule is decided from the syntax tree — which literal
  holds the key, which object the key is written into, how a binding
  resolves — not from key spellings, so a formatted multi-line literal or an
  indirect write cannot slip past it. The 68 current sites (13 shipped, 55 in
  test fixtures) are seeded as debt with their reason; a new site, a stale row
  or a changed reason reds. Commented env members, later constants, mutable
  aliases, and identity wrappers retain their path-key evidence.
