---
section: Added
audience: user
---

- **Opt-in: repeat injected findings in later requests so exact-prefix prompt caches keep hitting.** With `--lens-retain-injections` (or `contextInjection.retain: true`), pi-lens re-sends each injection unchanged, at the same place, in every later request of the session, labelled as a snapshot; findings are still delivered once. `cache_context` now records where each request stops repeating the previous one, and a cache miss that follows a request dropping an earlier injection is named `injection-dropped` (#4743).
