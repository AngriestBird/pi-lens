---
section: Fixed
audience: user
---

- **Writes and LSP edits share one lock and one containment root per file.** A `<dir-link>/../file` spelling no longer locks a different file in pi's mutation queue, a workspace edit's root is the directory the kernel opens, and a path identity stays put when it is resolved again (#4689). A workspace edit whose target the kernel cannot name — an unreadable ancestor, a looping link — is refused instead of confined by its spelling.
