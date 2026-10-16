---
section: Changed
audience: user
---

- **Sending a document to a language server counts its lines natively (#2066)** — each `didOpen`/`didChange` walked the whole document one character at a time to count lines and find the last one, about 70% of a send. A document with no carriage return is now counted with the native `indexOf`, about 10x faster (3.0 to 0.3 ms scan on a 1.96 MB document). Line counts and ranges sent to the server are unchanged, and a document with a carriage return takes the same loop as before.
