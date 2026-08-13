---
section: Fixed
---

- **npx formatter fallback honors style-preservation gating (closes #1345)** — Files that must be skipped by `SKIP_FORMATTING` no longer invoke the static Biome or Prettier `npx` fallback when a primary formatter command is unavailable.
