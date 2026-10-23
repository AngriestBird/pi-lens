---
section: Fixed
audience: user
---

- **An opengrep finding is no longer erased by a late empty publication (#4786)** — right after its rules load, opengrep could publish a file's finding and then an empty set for the same file: its open-documents scan clears every file it did not scan that time. pi-lens kept the last one, so the file read clean. An auxiliary scanner's unversioned empty publication now never replaces a finding from the same rules generation and the same send; a new send (an edit) or a rules refresh still clears it, and language servers keep last write wins. Each refusal is recorded as `lsp-auxiliary-empty-after-finding`.
