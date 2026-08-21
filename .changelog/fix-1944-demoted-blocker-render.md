---
section: Fixed
---

- **A demoted blocker no longer shouts STOP, and it stops re-serving forever (closes #1944)** — the past-EOF gate moved a blocker whose file had shrunk past the cited lines into the advisory channel, but the advisory embedded the blocker body verbatim, so the agent still read "🔴 STOP — 11 issue(s) must be fixed" with line numbers the file no longer had. Nothing retired the record either, so it re-served on every turn end for the rest of the session (measured live at 80+ minutes). A demoted body now drops the STOP banner and the "must be fixed" imperative, renders a dead coordinate as `L<n> (line no longer exists)`, and — when no re-run could ever confirm it — is delivered once and then retired, with the suppression recorded in the degradation ledger under `demoted-finding-retired`. `lens_diagnostics mode=delta` also stops printing 🔴 on a row whose coordinate it just replaced with the stale marker.
