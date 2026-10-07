---
section: Fixed
audience: user
---

- **`pi install git:…` no longer fails under `--strict-allow-scripts` while bundling (refs #4062)** — The from-source `prepare` bundle step installs esbuild through a nested `npm exec` that inherits the strict lifecycle-script policy but cannot see the package's `allowScripts`, so a strict install refused esbuild's `postinstall` (`ESTRICTALLOWSCRIPTS`). The nested install now approves exactly the package version it installs.
