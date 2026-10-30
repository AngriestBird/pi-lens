---
section: Fixed
audience: user
---

- **A blocker retires when the language server confirms the fix, even if a scanner stayed silent.** A partial language-server run now answers for the servers that answered: the primary's recorded blockers clear and the commit gate opens, while the unconfirmed auxiliary's own blockers stay pending and the coverage notice still names it. The `🔴 Still unfixed` line also lists a short rule id per line (`L64 ts:6133`) and says how many counted blockers have no current line, instead of counting lines it no longer lists. (refs #5008)
