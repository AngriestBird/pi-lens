---
section: Changed
audience: user
---

- **`@ast-grep/cli` is pinned to an exact version, and the install diagnostics find the bundled grammars (refs #1185)** — The `@ast-grep/cli` dependency is `0.45.3` instead of `^0.45.0`, so an install runs exactly the reviewed lifecycle script. The install selftest and the pasted install diagnostics now count the core grammars the package ships in its own `grammars/` directory, where they previously reported them missing ("postinstall did not run") on a healthy install. For contributors, `npm run check:allow-scripts` reconciles `allowScripts` with the lockfile (missing, mismatched, stale, name-only and floating entries) and CI installs through the pinned npm with `--strict-allow-scripts`.
