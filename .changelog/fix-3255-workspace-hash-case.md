---
section: Fixed
---

- **Two case-distinct workspaces no longer share one warm-IPC endpoint (refs #3255)**
  — the per-workspace id behind the warm socket/pipe and the
  `pi-lens-turn-end-*.json` status file lowercased the resolved cwd on every
  platform, so on a case-sensitive filesystem `/repo/Alpha` and `/repo/alpha`
  collided: a PostToolUse or Stop hook in one project could reach the other
  project's warm server, and `pilens_health` reported one workspace's turn-end
  activity under the other's name. The fold now runs only on the platforms
  whose filesystem folds case (Windows, macOS), where it is what lets the
  server and the hook meet. On Linux and the BSDs the id bytes change for any
  workspace path containing an uppercase letter: an old socket or status file
  in the OS temp directory is simply orphaned, and a hook upgraded mid-session
  falls back to cold analysis for one turn.
