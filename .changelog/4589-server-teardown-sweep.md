---
section: Added
audience: internal
---

- Add a `test-server-teardown` ratchet sweep for #4589: a test that starts a real listener reds unless the close promise is proven settled in a teardown hook, a `finally`, the start's own function, or a local helper that returns it and whose every call site settles it. `await xs.forEach(...)`, `await xs.map(...)`, `Promise.race` and a helper that drops the promise report instead of passing. A `bind`/`serve` start on a socket or runtime handle is in the population, and a receiver or construction the scan cannot read is reported as `unresolvable`, never counted clean. The sink drain sweep attributes a sink path at every parameter position of a same-file helper and judges the read where it runs, so a helper that suspends before its read voids the caller's drain and a helper that drains first is clean.
