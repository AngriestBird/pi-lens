---
section: Fixed
---

- **Native TS7 diagnostic waits stabilize versionless publication bursts (refs [#1412](https://github.com/apmantza/pi-lens/issues/1412))** — TypeScript wait strategy resolution now follows the launched server variant: classic typescript-language-server retains authoritative first-push seeding, while native `tsc --lsp --stdio` debounces provisional pushes until a quiet window or advertised pull provides the settled result. Bounded latency telemetry records publication shape and settle source without diagnostic text.
