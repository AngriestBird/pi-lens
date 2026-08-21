---
section: Fixed
---

- **Merge-train warden's `update-branch` kick 403s under branch protection (#1959)** — the workflow's job permissions granted `pull-requests: write` but not `contents: write`. The PUT `pulls/N/update-branch` endpoint has GitHub create a merge commit on the PR branch, which needs write access to repository contents, not just to the pull request object; the inline comment attributing it to `pull-requests: write` was wrong. The warden also now tells apart the two reasons update-branch can 403: a fork-owned head PR records a distinct benign outcome (`update-branch-forbidden-fork`, logged, not a run failure), while an own-branch PR still fails the run loudly, since that case is a real permissions bug like this one.
