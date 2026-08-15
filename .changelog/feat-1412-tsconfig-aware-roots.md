---
section: Fixed
---

- **TypeScript LSP roots follow governing configs (refs [#1412](https://github.com/apmantza/pi-lens/issues/1412))** — TypeScript and JavaScript files now prefer their nearest `tsconfig.json` or `jsconfig.json` (filtered by extension family — a `.ts` file skips a jsconfig-only directory) while preserving package-boundary client isolation, and classic servers emit bounded, read-only project-association telemetry after the first open. Classic-server tool discovery (`typescript-language-server`, `tsserver.js`) now walks up from a nested config root instead of only checking the root itself. Known accepted tradeoff: honoring nested config roots enlarges the population of roots subject to #1373's pre-existing open-order sensitivity.
