---
section: Fixed
audience: internal
---

- The backstop grace-retry cases own their follow-up sweep instead of racing its wall-clock timer (#4488, recurrence of #2669). A `graceRetryScheduler` seam hands a case the retry options production composed, so a loaded runner can no longer fail "grace retry did not complete" and leak a 5 ms sweep into the next case.
