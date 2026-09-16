---
section: Fixed
---

- **`with-memory-watch` survives a full stdout pipe instead of dying on it (closes #3097)** — the wrapper writes every record with `fs.writeSync` so `process.exit` cannot discard it, but fd 1 is not reliably blocking: `stdio: "inherit"` shares one open file description with the wrapped command, and libuv sets `O_NONBLOCK` on it as soon as that child initialises its own `process.stdout` on a pipe. A sampler tick that landed while a slow log reader held the 64 KB pipe full then threw `EAGAIN` out of the `setInterval` callback with nothing to catch it, and the wrapper exited 1 under exactly the backpressure it exists to survive (CI run 35067086859). `emit` now retries on `EAGAIN`, parking 5 ms per attempt, which is what a blocking write would have done; any other write error is permanent, so it is recorded once on stderr and the child's exit code is still forwarded.
