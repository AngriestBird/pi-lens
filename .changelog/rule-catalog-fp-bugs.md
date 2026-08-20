---
section: Fixed
---

- **Eight ast-grep rules stop flagging correct code, without trading false
  positives for false negatives** — the 2026-08-20 severity audit found
  broken escape valves, patterns that crossed function boundaries, and
  content-shape gaps that fired on parameterized queries and static markup.
  A follow-up adversarial review then caught three of the fixes
  over-correcting (an escape valve exempting more than the false-positive
  case, or a narrowed match losing a detection class); those are fixed too.
  Per rule: `no-dupe-class-members`'s static-modifier check missed `static
  async` methods (false positive) and, in the first fix, over-exempted
  static members entirely, losing genuine `static foo(){} static foo(){}`
  duplicates (false negative) — both fixed, staticness is now compared
  BETWEEN the pair, not blanket-exempted. `no-return-value-in-generator`
  conflated yield/return across nested functions. `no-compile-call` now
  suppresses literal and same-scope `ast.parse`-derived sources, scoped to
  the nearest enclosing function (a first pass climbed past nested
  functions) and with the single-argument call form restored.
  `no-server-bind-wildcard`'s first fix anchored to `.run`/`.listen`/
  `.serve` call targets, which missed `uvicorn.Config(...)`, bare
  `run(host=...)`, and other server-startup shapes — reverted to the
  original broad match with a narrow exclusion for the actual false
  positive (a pydantic `.model_construct()`/`.construct()` call).
  `no-sql-in-code`/`-js` now require string concatenation or template
  substitution, mirroring the already-correct Python sibling, and exclude
  literal-plus-literal concatenation (compile-time-constant text, nothing
  to inject); the residual corpus hits match the declared
  concatenation/substitution shape, though a few interpolate module-level
  constants rather than user input. `no-inner-html`/`-js` now exempt
  literal/empty-template RHS. `redundant-unsafe-function` now exempts a
  preceding `/// # Safety` doc comment, bounded to the comment block
  immediately above the function (an unbounded first pass let one
  `# Safety` comment anywhere earlier in the file exempt every later
  `unsafe fn`). `no-await-expression-member`/`-js` no longer recommend a
  rewrite that reads a property off the unresolved promise (prose only,
  no rule change; kept rather than retired — the corrected hint is not a
  no-op, though retirement stays available as a separate call).
  Refs #1806.
