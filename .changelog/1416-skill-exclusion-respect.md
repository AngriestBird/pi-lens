---
section: Fixed
audience: user
---

- **Skills you exclude with `packages[].skills` stay excluded (refs #1416)** —
  pi's settings package filters reached pi-lens only on paper. The extension
  also registered its whole `skills/` directory from the `resources_discover`
  hook, and pi merged that path into the session unfiltered, so a per-skill
  `!`/`-` exclusion or an empty `skills: []` was silently undone at session
  start. The hook now contributes no skill paths; the package manifest
  (`pi.skills`) is the sole registrar, so exclusions hold and the four shipped
  skills load as before.
