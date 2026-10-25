---
section: Fixed
audience: user
---

- **A gitignored file is skipped whichever way its path is spelled** — the project ignore matcher was rooted at the spelling it was handed, so a file reached through a symlink to the project (or through a link into it) read as outside the project and was never ignored: it was linted, formatted and read-tracked despite `.gitignore` or `.pi-lens.json` `ignore`. A pi-authored write to a nested `.gitignore` named through such a link also missed the instant cache eviction it owes, so the stale verdict lived until the next freshness window. Verdicts and the eviction now key by the project's real path (refs #4689).
