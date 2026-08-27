---
section: Fixed
---

- **Re-check test-runner negative verdicts instead of latching them (refs #2252)** — `TestRunnerClient.detectRunner` and `parseVitestTestGlobs` used to memoize "no runner"/"no config" for the process's whole life once probed. A config file added after the first probe (`vitest.config.ts` appearing, a project scaffolded mid-session) now converges on the same client instance instead of re-serving the earlier miss.
