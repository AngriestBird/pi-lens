---
section: Fixed
audience: user
---

- **A blocker retires when the language server confirms the fix, even if a scanner stayed silent.** A partial language-server run now answers for the servers that answered: the primary's recorded blockers clear, while the unconfirmed auxiliary's own blockers stay pending and still hold the commit gate shut, and the coverage notice still names it. Every edit after the once-only notice keeps naming it too, instead of reading clean. The `🔴 Still unfixed` line also lists a short rule id per line (`L64 ts:6133`) and says how many counted blockers it cannot place — one whose line could not be re-placed in the new bytes, and one with no line in this file — instead of counting lines it no longer lists. (refs #5008)
