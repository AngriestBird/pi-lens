---
section: Fixed
---

- LSP root detection no longer trusts a resolved project root for the rest of
  the session. Every memoized root carries the mtime of each directory its
  marker walk probed and is re-walked as soon as one of them changes, so a
  manifest scaffolded below an already-resolved root (`swift package init` in a
  subdirectory, a new `package.json`, `prisma/schema.prisma` written into an
  existing `prisma/`) moves the root on the next file touch, and a manifest
  deleted at the resolved root falls back to the outer project — neither needs a
  restart any more. All 45 marker detectors share the one seam (refs #3412).
