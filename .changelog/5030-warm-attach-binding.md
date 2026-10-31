---
section: Fixed
audience: user
---

- **An attached session no longer reads another session's stale answer as current.** When a pi-lens session shares a running language server through another session (warm attach), that session's answer now says whether its findings describe the bytes on disk, and the attached session treats findings about older bytes the way a local one does: they are not a verdict, a recorded blocker stays pending, and the tool and sweep results show them as unconfirmed. An answer from a session on an older pi-lens build carries no such statement and is treated as not current until both sessions run this build. (refs #5030)
