---
section: Fixed
audience: user
---

- A subagent whose new session is reloaded before pi-lens has seen it start no longer passes for the main session when it shuts down, so it cannot take over the main session's reload or fork and strip the reloaded conversation of its activated tools (#4106).
