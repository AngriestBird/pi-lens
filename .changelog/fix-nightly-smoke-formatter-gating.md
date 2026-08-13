---
section: Fixed
---

- **Unconfigured Python files are formatted again (refs #1144)** — `ruff format` rejects the `--indent-style`/`--indent-width` flags the style-preserving defaults were passing, exiting 2 without touching the file; because ruff was not treated as a strict-exit formatter, every unconfigured Python file silently reported "already formatted" and was never reformatted. Style is now pinned through ruff's inline TOML overrides, and a nonzero ruff exit is surfaced as a formatting failure instead of a clean no-op.
