---
section: Fixed
---

- **Deliver late cascade results instead of dropping them (closes #1443)** — A cascade whose compute missed the turn-end settle cap, or whose neighbor diagnostics landed in the quiet window after the turn ended, was carried over and then discarded unread: the turn-end filter rejected every run stamped with an earlier turn, so the carry-over path was dead code (the two measured cases were the highest fan-out cascades of the day). Late runs now merge into the following turn's output, a run superseded by a newer write is dropped with a logged record instead of silently, and the carry is bounded to one turn.
