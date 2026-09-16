---
section: Added
---

- **Stale carried findings are now re-verified against the live server before re-delivery (refs #3170)** — a deferred-origin finding whose file has not moved re-served turn after turn even when the root cause was fixed elsewhere (the #1093 cross-file class on the advisory lane). At turn_end, up to four such files per turn are re-observed through the probe's `touchFile` path (bounded wall budget and abort signal): converged findings are dropped via a supersede-not-union merge rule, re-confirmed ones are re-delivered as fresh observations, and a re-verify that cannot complete inside the budget renders an explicit "(re-verify incomplete)" gap label — never a false clean. One `persistent_reverify` latency record per pass.
