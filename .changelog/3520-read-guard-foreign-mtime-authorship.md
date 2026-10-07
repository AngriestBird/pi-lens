---
section: Fixed
audience: user
---

- **A file another writer changed is no longer treated as written by the agent (closes #3520)** — The read guard let a never-read file through the zero-read check whenever its modification time was newer than the session, and then injected a read of the whole file. An external editor, a second pi-lens, `git`, or a script run through `bash` therefore made every line of the file editable without a read. Only a write pi-lens observed counts as the agent's own now: the next edit of such a file asks for a read. Files the agent wrote, edited, formatted or fixed through pi-lens stay editable, and so do the files an applied LSP rename, code action or `ast_grep_replace` rewrote. A file written before a session reload is still carried across it. A file a `bash` script created, and a file idle past the read guard's 30-minute eviction, need a read before an edit.
