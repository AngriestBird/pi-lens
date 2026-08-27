---
section: Fixed
---

- **Move three Java rules off an inert `files:` negation glob (fixes #2280)** — `no-raw-types`, `no-string-concat-in-loop`, and `no-system-out-println` used `files: ["**/*.java", "!**/test/**"]` to carve out test files, but ast-grep 0.45.1's `files:` field has no negation support, so the exclusion silently did nothing. All three now use the real `ignores:` field ast-grep's engine honors natively, restoring the test-file carve-out.
