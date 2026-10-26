---
section: Changed
audience: internal
---

- **AGENTS.md split by seam (refs #4361)** — the defect-shape entries, the seven standing-invariant subsections, the orchestrator-only procedure and the release rules now live in `docs/`, each behind an index line or pointer in `AGENTS.md`; the moved text is verbatim with no rule reworded, the task router names the seam table, both reviewer bots load the catalog and the invariant files, and `scripts/check-pr-body.mjs` reads the shape catalog from `docs/defect-shapes.md` at the PR's merge base.
