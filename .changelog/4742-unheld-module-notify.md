---
section: Fixed
audience: user
---

- **A module changed on disk that no language server had open now reaches the live servers.** After a `git checkout`, merge, pull or an edit from another terminal, a server (pyright showed it) kept the old bytes of an imported module and reported every attribute of it as unknown on each later edit of the importer, until the server restarted. The HEAD-move, bash-write and settled-sweep looks now send those paths to the servers as watched-files events (#4742, #4535).
