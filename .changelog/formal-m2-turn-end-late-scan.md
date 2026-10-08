---
section: Added
audience: internal
---

- `formal/turn-end-late-scan` models the turn_end dead-code lane's late scan
  (park, settle, carry; #4117 round 2) with 17 TLC configs, including a foreign
  scan that stamps the shared client and bounded progress and delivery checks,
  registers three findings as `violated` (the settle-time poison guard compares
  with the row the scan started from, a failed in-flight scan drops its carried
  files, a new session joins the old session's running vulture), and maps
  `clients/dead-code-client.ts`, `clients/knip-client.ts` and
  `clients/hard-failure-summary.ts` to it (refs #3803).
