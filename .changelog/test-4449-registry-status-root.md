---
section: Fixed
audience: user
---

- **LSP status shows the whole project root (refs #4449)** — `/lens-health` and the engine status cut a client's root at its second colon, so a Windows root such as `c:/work/proj` read as `c` and a POSIX root such as `/srv/a:b/proj` as `/srv/a`. The root is now read the same way as in the breaker status, and evicting an adopted (foreign) project root no longer shuts down the language server of a different root whose path ends in `:` followed by the evicted root's path.
