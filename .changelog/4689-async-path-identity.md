---
section: Fixed
audience: user
---

- **Writes and LSP edits share one lock and one containment root per file.** A `<dir-link>/../file` spelling no longer locks a different file in pi's mutation queue, and a workspace edit's root is the directory the kernel opens (#4689).
