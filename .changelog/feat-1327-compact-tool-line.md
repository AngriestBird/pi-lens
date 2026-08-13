---
section: Added
---

- **Opt-in compact one-line tool result rendering (closes #1327)** — pi-lens tools can now render as a single theme-aware line (`<status glyph> <tool name> — <summary>`) instead of two rows, via `--lens-compact-tool-line` / `ui.compactToolLine=true` in `~/.pi-lens/config.json`. Default off — behavior is byte-identical when disabled. Expand-to-view-full-output is unchanged.
