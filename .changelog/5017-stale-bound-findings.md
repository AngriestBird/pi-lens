---
section: Fixed
audience: user
---

- **A blocker stays recorded when the language server answers for older bytes.** When the server's findings were computed for an earlier version of the file, the edit no longer treats them as a verdict on the new bytes: they are not delivered, a blocker recorded earlier stays pending and keeps the commit gate shut, and the next edit checks again. Before, such findings retired that blocker even though it was still in the file. (refs #5017)
