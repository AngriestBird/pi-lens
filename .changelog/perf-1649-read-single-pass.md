---
section: Changed
audience: user
---

- **Read-guard accounting reads a file once per tool call hook (#1649)** — a `read` used to re-read and re-split the whole file three times when it was called and three more when it returned. Now one bounded pass per hook counts its lines and hashes only the lines the read covers, in 64 KiB chunks, behind a size gate. Five search hits in one file now cost one pass instead of five. A bash `tail`/`head`/`cat` of a vendor or ignored file is dropped before its lines are counted. Read-guard verdicts are unchanged, except that a clipped bash view of a file over 512 MB now records one line instead of throwing.
