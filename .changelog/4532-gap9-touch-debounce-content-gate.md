---
section: Fixed
audience: user
---

- **Stop re-pushing byte-identical LSP content, and stop losing a save or a revert to the same gate.** The touch debounce now decides by the bytes the client sent and by whether that document's notify queue is still sending them, so a touch whose own work outlived the window no longer sends a redundant `didChange` that clears the server's diagnostics (#4532). A still-running save does not count as sending them either: it cannot change the document, so the cached diagnostics survive it. A skipped save still reaches the server, and a save whose notification fails is sent once more instead of leaving the server never told those bytes are saved. A client that cannot report what it holds is re-sent rather than skipped.
