---
section: Fixed
audience: user
---

- **Config and package lookups follow a symlink to the real directory.** pi-lens looks upward for tool configs, `.pi-lens.json`, the Python target version, a uv workspace, and the Cargo or Dart package of a fixer. Each lookup now starts at the real path, so a file reached through a directory or file link reads the config of the package it really lives in. An active virtual environment named through a link to the project counts as the project's own. A link-spelled home directory stops the search on both spellings. The project-local bin trust check and the git and analysis-root walks still use the path as written (#4689).
