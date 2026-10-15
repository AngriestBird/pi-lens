---
section: Fixed
audience: internal
---

- **The tool-smoke handshake lane reports an alternate row whose server is missing as unavailable again (#4403)** — since #4411, a touch that no language server answered returns the `primary-unavailable` verdict, not nothing, when a primary is off in `lsp.disabledServers`. Every alternate row disables its default, so the official Docker row failed with "got no warm client" on a runner without the binary instead of skipping. The lane now reads that verdict as "no client ready"; auxiliary rows keep their own findings.
