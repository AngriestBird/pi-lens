---
section: Fixed
---

- **Bound Svelte and Prisma language-server probes, and Vue's remaining dispatch-side budget (refs #2169, #2176)** — the Svelte and Prisma installer registry entries now carry their own cold-start `--version` verification ceilings (20s and 40s), matching real measured cold runs of 12.4s and up to 27.3s. Separately, Bash, JSON, Prisma, Vue, and Svelte language servers now raise the dispatch lsp-runner's 5-second cold-spawn wait floor to match their installer bounds, so a slow cold spawn cannot still read as unavailable after installer verification would have accepted it.
