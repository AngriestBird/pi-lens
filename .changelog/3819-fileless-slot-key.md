---
section: Fixed
---

- **A subagent's own /reload or /fork no longer takes the primary's session hand-off (closes #3819)** — In a file-less session, such as `pi --no-session` or an in-memory subagent, the hand-off slot matched on the start reason alone. A subagent that started while the primary was between its `/reload` or `/fork` shutdown and its successor's start, and then reloaded or forked itself, received the primary's lazy-tool activations, queued advisories and authored files. A file-less slot is now keyed by the ticket of the scope that left it. The real successor finds that ticket through the session manager pi hands it, and a subagent's start does not. Every primary session start now also clears a slot it did not take. Without that, a later reload of the session that the subagent's start displaced could still take the slot left before it was displaced.
