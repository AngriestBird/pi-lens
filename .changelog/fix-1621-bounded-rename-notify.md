---
section: Fixed
---

- **Rename propagation no longer hangs on a wedged LSP server (refs #1621, #1620)** — `LSPService.renameFile` awaited `client.closeDocument` and `client.didRenameFiles` with no timeout. A notification write on a pipe that is not draining neither resolves nor rejects, so one wedged server stalled its `Promise.all` and blocked the rename for every healthy client alongside it. Both notifies now carry their own budget (`PI_LENS_LSP_RENAME_NOTIFY_TIMEOUT_MS`, 1500ms). Rename propagation is best-effort advice to servers, not a correctness gate, so a timed-out `didRenameFiles` notify is recorded in the existing failure ledger and the rename still completes; a timed-out `didClose` still aborts and resynchronizes the rename, matching the existing failure path. Each ledger entry now carries a `disposition` of `timedOut` or `rejected`, so an empty failure list still means clean and a stall is never indistinguishable from a genuine rejection.
