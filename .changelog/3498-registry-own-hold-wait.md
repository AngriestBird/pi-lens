---
section: Fixed
audience: user
---

- Ending a session no longer freezes pi for 500ms when this process's own
  registry write is in flight. `/new`, `/fork`, `/reload` and quit remove the
  session's entry from the instance registry under a sync lock wait, and that
  wait blocks the event loop the in-flight write needs to release the lock, so
  it could only run out. The removal now skips the wait in that case and
  queues behind the write, as it already did after the wait (refs #3498).
