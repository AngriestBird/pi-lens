---
section: Changed
---

- **Terminal behavior now follows the pi host's run mode (refs #1334)** — pi-lens reads `ctx.mode` (`"tui" | "rpc" | "json" | "print"`) instead of assuming it owns an interactive terminal. The diagnostics widget mounts only in `tui`, and proactive `ui.notify` chatter is logged rather than rendered in the one-shot `print`/`json` modes, so piped and machine-readable runs stay clean. `/lens-widget-toggle` now says which mode is blocking it instead of blaming the pi version. Hosts that expose no `mode` field behave exactly as before.
