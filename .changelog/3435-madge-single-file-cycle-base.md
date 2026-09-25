---
section: Fixed
---

- **The turn-end circular-dependency pass keyed nested files by paths that do not exist (closes [#3435](https://github.com/apmantza/pi-lens/issues/3435))** — the single-file madge lane (`checkFilesBatch`, the pass `runtime-turn` runs) points madge at one file, and madge prints that file's cycle members relative to the target's directory. The client resolved them against the project root instead, so a cycle between `src/a.ts` and `src/b.ts` seeded the shared circular-file set with `<root>/a.ts` and `<root>/b.ts` — neither exists — and `isInCircular`/`getCircularForFile` answered false for the real nested files (`hasCircular` was right by accident, since it counts parsed cycles). Members now resolve against the target file's directory through the shared `parseMadgeCycles` reader, including `../` members for cycles that leave that directory. Pinned by fixtures captured from madge 8.0.0 with the client's own argv.
