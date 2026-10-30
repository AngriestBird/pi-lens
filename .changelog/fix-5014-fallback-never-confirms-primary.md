---
section: Fixed
audience: user
---

- **A fallback language server no longer confirms a file clean for a primary that never answered.** When the Python checker was refused (an adopted project's local binary), failed to start or was not installed, python-jedi answering with nothing read as "Primary LSP (python): confirmed clean". The file now reads unavailable and names the missing primary, for both server scopes (refs #5014).
