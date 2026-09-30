---
section: Changed
---

- **Move the dev and test baseline to pi 0.99.2 (refs #3805)** — The `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` devDependencies are now `^0.99.2`, the pi-host contract test pins pi's `_afterToolCall` event shape (`parentToolCallId`, `structuredContent`), and the fork/tree witness builds its tool context with pi's own `createToolContext`. The published supported-host window is unchanged until release-qa passes on 0.99.2.
