---
section: Fixed
audience: user
---

- **Refuse an adopted root's project-local LSP binary however PATH spells it.** `launchLSP` probed a
  bare server command with `which` from the pi-lens process's own cwd and kept whatever string came
  back, so a **relative** PATH entry had no resolvable path for the analysis-root permission gate to
  judge. The kernel resolves such an entry against the *child's* cwd, so a `node_modules/.bin` entry
  the pre-push hook chain exports (husky's generated `.husky/_/h`) made the bare
  `vscode-html-language-server` candidate exec an **adopted** root's own shim: the refusal classified
  nothing, and an adopted root — which may only reach global and managed binaries — ran project code.
  The probe now runs in the cwd the server is spawned with and returns an absolute path, so the
  classified path is the executed path; the relative-entry rule is the one
  `commandSearchReachesProject` already states for the repair seam. Witnessed by the `#4299 R2-F1`
  HTML-launcher cell under a relative PATH entry (refs #4532).
