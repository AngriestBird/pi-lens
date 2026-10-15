---
section: Fixed
audience: user
---

- **A language-server leader dropped from the held-pid set is now recorded (#3096)** — When 256 language-server groups are all still alive, the next launch drops the oldest held pid, and a group kill after that leader dies is refused. `holdOwnChildPid` now counts that drop as `held-own-pid-evicted` in the degradation ledger, once per launch that evicts, with the launch site as the subject and the dropped pid in the reason. A launch that evicts nothing records nothing. `tests/clients/lsp/kill-process-tree-real-child.test.ts` fills the set through the real `launchLSP` path and reads the record back from `latency.log`.
