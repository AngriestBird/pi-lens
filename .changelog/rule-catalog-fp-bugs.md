---
section: Fixed
---

- **Eight ast-grep rules stop flagging correct code** — the 2026-08-20
  severity audit found broken escape valves, patterns that crossed function
  boundaries, and content-shape gaps that fired on parameterized queries and
  static markup. Fixed the mechanism in each: `no-dupe-class-members`'s
  static-modifier check missed `static async` methods entirely (3 FP hits
  collapsed to 0 on inspiration-pi); `no-return-value-in-generator` conflated
  yield/return across nested functions (3 hits to 1, the remainder a
  separate `__await__` idiom, not this bug); `no-compile-call` now suppresses
  literal and `ast.parse`-derived sources (3 hits to 0); `no-server-bind-wildcard`
  now anchors to `.run`/`.listen`/`.serve` call targets (1 hit to 0);
  `no-sql-in-code`/`-js` now require string concatenation or template
  substitution, mirroring the already-correct Python sibling (261 hits to 29,
  all genuine); `no-inner-html`/`-js` now exempt literal/empty-template RHS
  (8 hits to 5, all genuine); `redundant-unsafe-function` now exempts a
  preceding `/// # Safety` doc comment, matching the `SAFETY:`-comment valve
  already shipped for `no-chained-type-assertions`; and
  `no-await-expression-member`/`-js` no longer recommend a rewrite that
  reads a property off the unresolved promise (prose only, no rule change).
  Refs #1806.
