---
section: Fixed
audience: user
---

- **The MCP warm side-channel restarts after a killed server on a long TMPDIR.** The server and the pi warm-attach host now unlink the socket file Node actually bound (it cuts a path past `sun_path`), so a stale socket no longer fails the next start with `EADDRINUSE`; the tmp-fixture hygiene owner also stops excusing creator-run leaks, and the MCP test harness removes the truncated socket name (#4353, #4354).
