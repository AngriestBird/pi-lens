---
section: Fixed
---

- **A session swap that starves `session_start` or `context` is now counted, not misreported as a pi-lens crash (closes #1929)** — both handlers survived a dead extension ctx already, but each logged it as `session_start crashed: …` or `context event error: …` and recorded nothing, so a replacement that kept starving them was invisible in aggregate. Both now run through the shared stale-ctx wrapper and leave one bounded `extension-ctx-stale` record keyed to the event name. `context` uses a new value-returning wrapper variant that states its stale-path answer explicitly: `undefined`, pi's "this extension contributed nothing", so the host keeps its own message list rather than receiving a half-built injection. Seven of twelve `pi.on` registrations are now wrapped, up from five.
