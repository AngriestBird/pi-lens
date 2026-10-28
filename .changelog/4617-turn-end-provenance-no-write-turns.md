---
section: Fixed
audience: user
---

- **Stop labelling current turn-end findings as historical on turns that wrote no file.** The turn-end stamp now covers the files a resolution retired and the files its cascade, pending-error and late-auxiliary sections cite, with `--lens-guard` on or off. (refs #4617)
