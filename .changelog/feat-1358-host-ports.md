---
section: Added
---

- **HostPorts capability boundary (refs #1358, S2)** -- a typed interface over every host capability the engine consumes (notify, trust, mode, log, emit, status, spawn policy, render, session, workspace, flags, tools), with headless-parity defaults and the existing getter seams as thin adapters; no behavior change, direct-ctx migration deferred to S4.
