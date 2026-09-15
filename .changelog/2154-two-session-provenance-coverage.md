---
section: Fixed
---

- **Bind cached project findings to the bytes they were scanned from (refs #2154)** — a cheap-tier finding whose file changed while the scan was running used to be served as a current blocking error in every later session; rows now carry the size and hash of the content the rules read, so a second session sees the finding retired instead.
