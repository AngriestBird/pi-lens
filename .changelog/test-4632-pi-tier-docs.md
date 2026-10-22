---
section: Changed
audience: internal
---

- **Contributors are told which real pi tier a host-semantics test belongs on, and the hand-built pi double now refuses to load for a test file off an admit list (#4632, slice 10 pulled forward).** AGENTS.md "Test requirements" names tier 1 (`tests/support/pi-runner.ts`) and tier 2 (`tests/support/pi-session.ts`) and the rule that a case about a handler's return value, the model's request or session ordering uses one of them. `tests/support/pi-mock.ts` throws at load unless the running test file is one of the 58 on `PI_MOCK_IMPORTERS`; `tests/config/pi-mock-importer-sweep.test.ts` fails on a row whose file stopped using the double, so the list only shrinks.
