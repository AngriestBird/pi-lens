---
section: Added
---

- **Reset-interleaving test explorer (refs #1840)** — `tests/support/reset-explorer.ts` runs an async path under test once per await point it exposes, firing a session-reset hook at that exact point each time, and checks caller-declared invariants after every run. The session-straddling defect shape (a reset landing mid-await, a budget re-arming, a write landing in the wrong session) recurred five times in one review window and every instance was caught only because a reviewer picked one await point by hand; this makes that exhaustive instead of lucky. Adopted on `clients/installer/managed-tool-refresh.ts`'s walk (the #1746 R2-F1 shape) as the reference consumer.
