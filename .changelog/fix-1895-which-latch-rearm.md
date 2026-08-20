---
section: Fixed
---

- **Formatter PATH availability re-arms at session start (closes [#1895](https://github.com/apmantza/pi-lens/issues/1895))** —
  formatter `which` latches now clear with the primary session reset, so a
  formatter binary installed or removed between sessions is detected on the
  next session instead of keeping the previous session's verdict.
