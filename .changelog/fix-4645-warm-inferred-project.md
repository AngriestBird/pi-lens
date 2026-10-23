---
section: Fixed
audience: user
---

- **Keep inferred-project diagnostics non-blocking under warm attach (closes #4645).** An attached session now labels and demotes TypeScript errors for files outside every tsconfig project, as a local session does. The longest-lived process sends the server's own diagnostics together with its answer about project membership. The attached session then runs the usual demotion on both and keeps the quick fixes. When the membership answer is late, the reply still arrives in time but carries no answer, and the error stays blocking. The change applies once both the attached session and the longest-lived process run this version. With an older process on either side, the error still blocks as before.
