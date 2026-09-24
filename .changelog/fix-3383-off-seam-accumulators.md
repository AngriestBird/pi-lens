---
section: Fixed
---

- Bounded every remaining stream `data` handler that grew a string without a
  ceiling (#3383): the forked analyze worker's pipes, the unref'd process-table
  collector, the installer's two interpreter user-base probes, and all four
  newline-framing readers (the MCP host's stdin loop, the warm IPC clients and
  the shared server-side reader). A peer that never sends a newline, or a child
  that never stops writing, now ends in a bounded failure with a ledger row
  instead of an uncatchable `RangeError` raised inside the handler. The
  self-signal re-raise at host shutdown is likewise total.
