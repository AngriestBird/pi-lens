---
section: Fixed
audience: internal
---

- Real-harness and MCP-harness teardown now kills the whole process tree of
  the child it started (the real pi leaves detached grandchildren such as
  knip, `ast-grep scan` and `typescript-language-server --version` alive
  after SIGKILL, still writing under the scratch home), waits a bounded 5 s
  for the tree to be gone, and removes scratch directories with a bounded
  loop of fresh `rmSync` calls instead of Node 22's in-call retries, so a
  passing scenario can no longer fail with an `ENOTEMPTY` teardown error
  (refs #4081).
