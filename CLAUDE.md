# CLAUDE.md

Deliberately thin. Reading order: the engineering principles (in your global
instructions; vendored at `docs/engineering-principles.md`), then
[AGENTS.md](AGENTS.md), the canonical contract for this repo — read it before
writing code, especially "Recurring defect shapes" — then the role contract
for the task.

## Non-negotiables (the short list)

- `npm run build` before any test run. Compiled `clients/*.js` are the runtime;
  unbuilt TypeScript changes are silently ignored by the tests.
- `git stash` is forbidden — it is repo-global across worktrees. Use
  `git diff > fix.patch` / `git checkout --` / `git apply`. Mechanically
  enforced (with its sibling rules, including "hooks always run": no
  `--no-verify`, commit `-n`, `-c core.hooksPath=`, `HUSKY=0`, #3778) by the
  `scripts/hooks/guard-bash.mjs` `PreToolUse` hook (#2699) — see AGENTS.md
  "Contributing".
- Prove every new regression test red on pre-fix code, and keep the output.
- Run targeted test files while iterating. The full suite runs once, and is
  serialized machine-wide (#1112); CI is authoritative.
- Changelog: one fragment file in `.changelog/` per change. Never hand-edit
  `CHANGELOG.md`.
- PRs: issue ref in the title. `closes` only when every acceptance criterion is
  met; otherwise `refs` plus an issue comment naming the remainder. After any
  push, verify Unit tests and Lint actually execute on the new head — a
  merge-conflicted (DIRTY) PR silently skips them.
- Availability/probe code: apply the recurring-defect catalog in `AGENTS.md`,
  especially shapes 10, 13, 17, and 18. Repeated degradations use
  `recordDegradationOnce` / `incrementDegradationCount`.

## Orchestration assets

- `docs/pi-lens-subagent.md` plus one of `docs/pi-lens-{fixer,reviewer,investigator,monitor,warden,retro}.md`
  — the role contracts, the only home of role rules.
- `.claude/agents/pi-lens-{fixer,reviewer,investigator}.md` — thin Claude Code
  wrappers: frontmatter, a pointer to the contracts, and harness-only lines.
- `.claude/skills/merge-train/SKILL.md` — the review → verify → merge policy.
- `.claude/skills/retro/SKILL.md` — the retrospective: environment changes,
  not advice (contract in `docs/pi-lens-retro.md`).
