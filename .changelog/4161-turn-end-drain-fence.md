---
section: Fixed
audience: user
---

- A turn-end that was still running when you started a new session (`/new`, or a resume) no longer takes the new session's pending findings (cascade results, late scanner findings, cut advisories) and loses them; they now reach the new session's next turn.
