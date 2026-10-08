---
section: Fixed
audience: internal
---

- SonarCloud now classifies `vitest.config.ts` as a test file through `.sonarcloud.properties`, so the main-source rule typescript:S5443 no longer reports the Windows `TEMP`/`TMP` long-spelling pin there as a vulnerability; product code keeps the rule.
