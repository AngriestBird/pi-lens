---
section: Changed
audience: internal
---

- **Two host-wiring test files moved off the hand-built pi double onto the real tiers (#4632 slice 8)** —
  `tests/index-process-bridge-registration.test.ts` now loads the built extension through pi's own
  `ExtensionRunner` (`tests/support/pi-runner.ts`) and reads the process-global bridge slots the loaded
  copy mounted; `tests/index-memory-sample-wiring.test.ts` runs real prompts through a real
  `AgentSession` (`tests/support/pi-session.ts`) and reads the `memory_sample` record the loaded copy's
  writer queued, through a new `PiSession.latencyRows()` accessor. Both files' `pi-mock` rows and the
  memory-sample file's three `in-process-mock` baseline rows are deleted. The reader files slice 8 could
  not move keep their rows with a stated class and reason. No product behaviour changes.
