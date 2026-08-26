---
section: Fixed
---

- **Correct the Java rule set's accumulator and raw-type detection (refs #2197)** — `no-string-concat-in-loop` now requires the accumulator to be a String, so it stops firing on numeric accumulation and starts catching `s += x`. `no-raw-types` skips `instanceof` and `.class`, which have no parameterized form, and reports raw types nested in type arguments.
