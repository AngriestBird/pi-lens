---
section: Fixed
audience: user
---

- **A stalled grammar download now fails after 15 s, not 300 s** (#4425). The runtime fetch of a missing tree-sitter grammar and the install-time `download-grammars.js` both give up once no bytes arrive for 15 s. A slow connection that keeps delivering still completes. A black-holed CDN used to hold the first parse of a language such as Kotlin for undici's 300 s headers timeout.
