---
section: Fixed
---

- **Actionable-warning and code-quality-warning ids now canonicalize the file
  path like disposition anchors already did** — `createActionableWarningId`
  and `createCodeQualityWarningId` hashed a RAW `relativeFile`, so a
  drive-letter-case or slash-variant file path produced a different id than
  `diagnostic-dispositions.ts` would compute for the same file (the #533
  orphaned-record class, swept from 1 of 3 copies to all 3). Both now share
  `clients/finding-identity.ts`'s canonicalizing `relativeFile` and 12-char
  hash length; a warning already suppressed in
  `actionable-warning-state.json` under the pre-fix, 10-char id is still
  honored and migrated forward onto the new id (#1816).
