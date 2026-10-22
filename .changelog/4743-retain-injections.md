---
section: Added
audience: user
---

- **Keep injected findings in later requests (opt-in) so exact-prefix prompt caches stop re-processing the conversation.** With `--lens-retain-injections` (or `contextInjection.retain: true`), pi-lens re-sends each injection unchanged, at the same place, in every later request of the session, labelled as a snapshot; findings are still delivered once. `cache_context` now records where each request stops repeating the previous one, and a cache miss that follows a request dropping an earlier injection is named `injection-dropped` (#4743).
