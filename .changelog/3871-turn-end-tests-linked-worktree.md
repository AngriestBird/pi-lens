---
section: Fixed
---

- turn_end now selects and runs tests for an edit in a linked worktree of the session's repository in that worktree's own root, with its own config and `node_modules` (no more zero turn-end tests when the session cwd is the main checkout); independent clones and submodules stay excluded, at most 3 linked worktrees get tests per turn (the rest are counted as `turn-end-test-root-skipped`), and `test-target-foreign-checkout` rows now carry `sameCommonDir` (#3871)
