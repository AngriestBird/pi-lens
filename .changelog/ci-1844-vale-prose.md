---
section: Added
---

- **Vale prose lint with a vendored Google style base (refs #1844)** — `.vale.ini` at the repo root scopes Vale to `docs/`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `.claude/agents/*.md`, and `.changelog/*.md`, using the Google style package vendored under `.vale/styles/Google/` (no `vale sync` at CI time) plus a `pi-lens/` style with three house rules: no `please` in instructions, an em-dash-density check, and a long-sentence check. A new advisory `vale` job in `lint.yml` runs it on every PR. Because the in-product `vale` runner (`clients/dispatch/runners/vale.ts`) activates on `.vale.ini` presence, dogfood sessions now surface Vale findings on doc edits too.
