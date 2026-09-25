---
section: Changed
---

- **Release-QA rows for the global config location and the shadowed-global record (refs #2608)** — the matrix now drives a real pi-lens MCP server with `PI_CODING_AGENT_DIR` set and `extensions/pi-lens.json` present and witnesses that the agent-dir file supplies the global tier, and with both global files present witnesses the once-per-session `config-location-shadowed` record (`PILENS_CFG_0010`) holding its count at 1 across repeated config loads.
