---
section: Security
audience: user
---

- **Workspace edits no longer write outside the workspace through a dangling symlink (closes #4877).** A `create` or `rename` whose path is a symlink to a missing file is refused instead of confined by its spelling.
