---
section: Changed
audience: internal
---

- **AGENTS.md split by seam (refs #4361)** — the defect-shape entries, the seven standing-invariant subsections, the orchestrator-only procedure and the release rules now live in `docs/`, each behind an index line or pointer in `AGENTS.md`; the text is moved verbatim, no rule reworded, and `scripts/check-pr-body.mjs` reads the shape catalog from `docs/defect-shapes.md` at the PR's merge base.
