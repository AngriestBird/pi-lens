---
section: Changed
audience: internal
---

- **AGENTS.md split by seam (refs #4361)** — the defect-shape entries, the seven standing-invariant subsections, the orchestrator-only procedure and the release rules now live in `docs/`, each behind an index line or pointer in `AGENTS.md`; the moved text is verbatim apart from two rule lines, the task router naming the seam table row and the file it names, and one seam-table path corrected to `clients/formatters.ts`. Both reviewer bots load the catalog and the invariant files, and `scripts/check-pr-body.mjs` reads the shape catalog from `docs/defect-shapes.md` at the PR's merge base.
