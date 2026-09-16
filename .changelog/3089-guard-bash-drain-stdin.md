---
section: Fixed
---

- **Drain stdin to EOF in the guard-bash PreToolUse hook instead of a single `readFileSync(0)` (#3089)** — `spawnSync`'s own `input` pump sets the child's stdin pipe non-blocking, so a `read(2)` issued before the next chunk lands can throw `EAGAIN`; `readFileSync(0, "utf8")` does not retry that, the throw was swallowed as "no payload", and the hook failed OPEN (exit 0) on a command — like `git stash` — it would otherwise have denied, measured reproducible from ~500 KB of JSON payload. `readStdin` now loops `fs.readSync` into a buffer list, retrying `EAGAIN` with an `Atomics.wait` park (the same mechanism `scripts/with-memory-watch.mjs` uses on its write side) and stopping only on a true EOF (`bytesRead === 0`); a read error or a genuinely empty stream is still "no payload".
