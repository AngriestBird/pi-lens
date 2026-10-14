---
section: Fixed
audience: user
---

- **The MCP warm side-channel restarts after a killed server on a long TMPDIR.** The server and the pi warm-attach host now unlink the socket file Node actually bound (it cuts a path past `sun_path`), so a stale socket no longer makes the next start fail with `EADDRINUSE` (#4353).
