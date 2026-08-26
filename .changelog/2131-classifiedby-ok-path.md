---
section: Fixed
---

- **Stamp classifiedBy on ok-path availability decisions (refs #2131)** — seven `logAvailabilityDecision` success-arm calls (biome, dead-code, formatters, jvm-runtime, package-manager, zizmor) omitted `classifiedBy`, so a `cause: "ok"` row could not be attributed to a probe or a caller-asserted repair from the log alone. All seven now stamp `"probe"` for a direct probe success or `"caller"` for an install/join-repaired one, matching their sibling failure arms. A sweep test pins every `cause: "ok"` emit site so the gap cannot recur unnoticed.
