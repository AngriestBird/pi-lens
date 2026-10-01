# CLAUDE.md

The contract is [AGENTS.md](AGENTS.md); read it before writing code, starting
with its "Recurring defect shapes". Claude Code does not load AGENTS.md
automatically, so this file carries only what a Claude session needs before
that read, plus the Claude-specific assets.

- `npm run build` before any test run; tests execute the compiled twins.
- `scripts/hooks/guard-bash.mjs` (`PreToolUse`) denies `git stash`, hook
  bypasses, and the rest of AGENTS.md "Contributing". Fix the command; never
  route around it.
- Role contracts are `docs/pi-lens-*.md`; `.claude/agents/` holds the Claude
  agent definitions for those roles, and `.claude/skills/` the retro
  procedure; the merge policy is `docs/pi-lens-merge-policy.md`.
