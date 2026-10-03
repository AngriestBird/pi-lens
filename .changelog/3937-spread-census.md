---
section: Changed
audience: internal
---

- Narrow the mutation-bridge epoch/lineage census to its provable floor: an
  object-valued binding is OPAQUE, so the fold proves the `lineage` VALUE only
  for an object literal written at the call site (or a
  conditional/short-circuit of such literals), never for a name. Any heap
  alias carrier — a property value, an array element, an assignment RHS, a
  conditional arm, a destructuring source, a nested argument, a reflective
  member mutation, or a bare alias — can no longer read `safe` beside an
  epoch, and the `const b = a` alias fixed point and unknown-callee escape rule
  are deleted because the opaque default subsumes them. A lineage VALUE
  variable is still followed when no statement rebinds it. Every annotation
  stays MAYBE (no type resolver), a computed template key with a substitution
  and an undecoded escape are dynamic, and a `null` literal is not a defined
  proof. The `Object.assign` fold is deleted (a call result is opaque), and the
  reachable-profile bound (fourteen of sixteen) is pinned (#3937).
