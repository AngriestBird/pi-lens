---
section: Fixed
audience: user
---

- **Parallel bash writes keep their blockers (closes #4137)** — When one assistant message ran several bash calls at once (several top-level calls, or a codemode `Promise.all`), only one of them reported the blockers of the file it wrote; the others said the file was clean and the blockers never reached the next turn. Each bash call now keeps its own pre-command baseline, so every written file reports in the tool result or at turn end, a baseline lost to a host without distinct tool-call ids is counted as `opaque-baseline-lost` in the degradation summary, and a script that rewrites or touches a file without changing the bytes a blocker was reported on no longer clears that blocker or reports it resolved.
