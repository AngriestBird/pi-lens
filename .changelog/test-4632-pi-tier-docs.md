---
section: Changed
audience: internal
---

- **Contributors are told which real pi tier a host-semantics test belongs on, and a registered-or-fail ratchet stops new `pi-mock.ts` importers (#4632, slice 10 pulled forward).** AGENTS.md "Testing" names tier 1 (`tests/support/pi-runner.ts`) and tier 2 (`tests/support/pi-session.ts`) and the rule that a case about a handler's return value, the model's request or session ordering uses one of them. `tests/config/pi-mock-importer-sweep.test.ts` lists today's 58 files that use the hand-built double; a new one fails, and a file that stops using it must leave the list.
