---
section: Changed
---

- **Auto-rerun the second infra kill on one head, and sweep master-only workflow lanes (refs #2042, #3043)** — the infra-kill rerun lane now classifies attempts 1 and 2 (`run_attempt <= 2`) and keys its once-per-head rerun guard on sha *and* run attempt with a two-rerun cap, so a runner that 137-kills the same head twice no longer needs a hand-pressed attempt 3; `finalize-rerun` moves to the terminal attempt. A new registered-or-fail sweep over every `.github/workflows/*.yml` fails any job whose `if:` no pull_request context can satisfy unless it is registered with a reason, and `install-smoke`'s `smoke` and `mise-repro` each gain one pull_request cell instead of their master-only gate.
