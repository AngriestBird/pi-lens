---
section: Fixed
---

- **Preserve pyright's information severity in dispatch (closes #1802)** — `pyright` collapsed every `"information"`-tier diagnostic to `warning`, even though pyright's own `--outputjson` output declares `error`/`warning`/`information`. Pyright findings now carry the same four-tier `Diagnostic.severity` biome-check adopted in #1791: `information` maps to `info`. Only `error` still blocks. `rust-clippy`'s mapping was investigated as a possible sibling instance and confirmed genuinely two-valued: rustc/clippy's top-level `compiler-message` entries with a real span are always `error` or `warning`; `note`/`help` only ever appear as nested child annotations, never as the root diagnostic level.
