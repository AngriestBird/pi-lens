---
section: Fixed
audience: user
---

- **Out-of-band declaration changes publish in a stable, code-unit order** — the
  declaration walk now sorts the files it found with an explicit code-unit
  comparator (`compareKeys`) instead of a bare `.sort()`. The order feeds the
  `pathChanges` payload subscribers receive, so it must not depend on the locale
  or ICU build of the machine that observed the disk (SonarCloud `typescript:S2871`).
