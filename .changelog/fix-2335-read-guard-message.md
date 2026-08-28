---
section: Changed
---

- **Concise zero-read recovery (closes #2335)** — The read guard now delivers its edit-without-read instruction as a single paragraph instead of a three-paragraph block. The 🔄 RETRYABLE marker and the "in this conversation" scope are unchanged.
