---
section: Fixed
audience: internal
---

- **`ci-verdict` no longer gates on check-runs from schedule or dispatch workflows (closes #4090)** — A check-run whose workflow run came from `schedule`, `workflow_dispatch`, `repository_dispatch` or `workflow_run` is advisory: reported on an `Advisory by trigger` line, never gating. A required name, a name with any pull_request/push run, and a row the run read could not classify keep gating, with a `Trigger scope:` line naming the unclassified ones. The daily `Detect untriaged issues` run no longer reds master's head, and the `Stryker shard` rows from a dispatched nightly no longer red the PR it was dispatched on.
