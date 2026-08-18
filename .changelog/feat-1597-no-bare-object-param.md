---
section: Added
---

- **ast-grep rule: ban bare `object` parameter annotations (Refs #1597)** — Add `no-bare-object-param` to the shipped rule catalog (TypeScript only — JavaScript has no type annotations to match). Fixes the one pre-existing hit, `clients/host-ports.ts:8`'s `HostLogSink` callback type, by narrowing it to `Record<string, unknown>`.
