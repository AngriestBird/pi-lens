---
section: Changed
audience: internal
---

- Narrow the mutation-bridge epoch/lineage census to its provable floor: the
  bounded per-output fold proves the `lineage` VALUE (not merely the key) only
  for literals, constructors, and a local initializer, and treats every
  annotation as MAYBE (no type resolver), so a named nullable alias, a generic,
  an import, or a local shadow can no longer read `safe` beside an epoch. An
  identity alias (`const b = a`) and an escape through an unresolved callee
  taint the aliased binding, while a copy spread does not; a computed template
  key with a substitution and a literal carrying an undecoded escape are
  dynamic; and a `null` literal no longer serves as a defined proof. The
  reflective-mutation table is deleted because the escape rule subsumes it.
  Every unresolved forwarding is registered with a checked reason, and the
  reachable-profile bound (fourteen of sixteen) is pinned (#3937).
