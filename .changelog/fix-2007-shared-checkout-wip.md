---
section: Added
---

- **Guard a shared checkout against branch switches that destroy another session's work (refs #2007)** — a new opt-in `--lens-checkout-guard` (`guard.sharedCheckout=true`) declines `git checkout`, `switch`, `restore`, `reset --hard`, `stash`, `clean`, `merge`, `rebase`, `pull`, `cherry-pick`, and `revert` when the checkout has uncommitted work and another live pi-lens session is registered on the same root. The refusal names the peer pids and tells you to commit or take a dedicated worktree, rather than moving anyone's work behind their back. Command classification reuses the existing git-guard shell analysis; peer liveness reuses the instance registry.

> Refs #2007
