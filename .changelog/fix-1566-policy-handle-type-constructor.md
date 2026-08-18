---
section: Fixed
---

- **The availability-policy coverage gate no longer inherits routing from a memo that merely mentions a policy handle's name (refs #1566)** — The #1552 whitelist checked whether a policy handle's name appeared anywhere in the memo's declared type or value. A memo typed `Awaited<ReturnType<ReturnType<typeof makeToolProbe>>>` unwraps a routed wrapper's return type down to a plain boolean, and a memo built by `emptyCache<boolean>(makeToolProbe)` merely hands the wrapper to an unrelated helper as an argument — both spell the handle's name without holding the handle, and both inherited routing they never earned. The gate now requires the handle's name to be the memo's own un-nested `ReturnType<typeof name>` or its own direct `= name(...)` call, so a name present anywhere else in the text no longer counts.
