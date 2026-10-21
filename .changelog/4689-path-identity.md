---
section: Fixed
audience: user
---

- **A symlinked file is one file to the read guard and to bash write attribution.** On Linux and macOS, a file read through a symlink and edited through its target (or through a directory link) is no longer refused as never read, and a bash write through a link now reports the blockers the real path reports instead of "clean". Path keys now resolve links the way Windows keys already did. In a project opened through a link, pi-lens now keeps one project data directory, named from the real path: a disposition mark silences its finding on the next write, and the marks, caches and session data an earlier version stored under the link's path are copied over once when the session starts, with the old directory left in place (#4689).
