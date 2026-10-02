---
section: Fixed
---

- The PR body check's record-harvest scan now blanks a block comment's continuation lines in place. Under `git diff --unified=0` a backtick or quote in a JSDoc body no longer opens a string that hides the real record literal below it, and a prose `recordDegradationOnce(...)` inside that body no longer satisfies the check (#3906).
