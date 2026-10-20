---
section: Fixed
audience: user
---

- **Run shipped checks through symlinked script paths.** The loader-cache warm and RPC load check now resolve entry paths through one shared helper instead of silently exiting without running; log analysis prints help once through either path spelling (refs #4096).
