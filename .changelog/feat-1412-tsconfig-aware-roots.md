---
section: Fixed
---

- **TypeScript LSP roots follow governing configs (refs [#1412](https://github.com/apmantza/pi-lens/issues/1412))** — TypeScript and JavaScript files now prefer their nearest `tsconfig.json` or `jsconfig.json` while preserving package-boundary client isolation, and classic servers emit bounded project-association telemetry after the first open.
