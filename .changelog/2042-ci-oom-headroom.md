---
section: Fixed
---

- **Stop the CI kill record from blaming memory it never ran out of (refs #2042)** — the `[mem-watch]` verdict asserted "the OS reclaimed memory" for every exit-137, including three real kills whose own low-water mark showed 13.0-13.3 GB of 16 GB still available. It now classifies from its numbers, emits a distinct `KILLED WITH HEADROOM` verdict when the box had room, and names the pid it was watching. A new failure-gated CI step captures the kernel's own `dmesg` and `systemd-oomd` records, so the next occurrence names the signal's sender.
