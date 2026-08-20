---
section: Fixed
---

- **Orphan backstop: off the session-start critical path, with verified kills ([closes #1857](https://github.com/apmantza/pi-lens/issues/1857))** —
  The registry-independent orphan sweep scanned the OS process table inline at
  session start. One dogfood session measured that scan at 9344ms, overlapping
  and starving language-profile warmup. The sweep now runs on an unref'd timer
  30 seconds after session start, under a machine-wide 30-minute cooldown, with
  a 5-second hard timeout on the enumeration child. Session start pays nothing.

  Three correctness defects went with it. Kill outcomes were counted as
  successes: `killPidTree` returned no signal, so a permanently unkillable
  process reported as reaped and paid the full sweep again every session. Kills
  are now verified by a post-kill liveness poll, and a survivor is recorded by
  identity (`<binary>#<pid>`) through the degradation ledger. The sweep's only
  record used to be a `{scanned, killed}` count on the reaped path, so "ran and
  found nothing", "never ran", and "threw" were the same absence; every sweep
  now logs one of `clean`, `reaped`, `error`, `cooldown`, or `disabled`. And a
  name-matching process spawned seconds ago but not yet registered was
  kill-eligible the moment its launcher shim exited — a window measured at
  890ms in the same session — so a process must now be at least 60 seconds old
  before the backstop will touch it.

  The registry-driven reaper carried the same attempt-counted-as-kill defect
  and gets the same verified accounting.

  Review round: the sweep runs under the repo's cross-process directory lock,
  so two sessions starting together cannot both pay for it. A candidate spared
  by the spawn grace arms exactly one follow-up sweep, instead of waiting for
  a next session that a long-lived host may never start. The scan timeout
  terminates the scanner child through the same tree-kill-and-verify path an
  orphan gets, rather than firing one unverified signal and walking away. And
  a sweep whose kills all failed reports `unverified`, not `reaped` — the same
  accounting defect this work exists to fix, reproduced one level up at the
  outcome surface.
