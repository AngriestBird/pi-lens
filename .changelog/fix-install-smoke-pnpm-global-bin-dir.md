---
section: Fixed
---

- Put pnpm 11's resolved global bin directory (`$PNPM_HOME/bin`) on PATH in
  install-smoke's pnpm setup, and run one `pi-load` pnpm-global cell on
  pull requests so the lane cannot ship untested again.
