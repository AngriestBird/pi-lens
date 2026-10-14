---
section: Fixed
audience: user
---

- **A Dart file with a compile error is no longer dropped as a rejected run (#1937)** — `dart analyze` exits 3 when it reports an error, 2 for warnings and 1 for infos. The runner's exit table stopped at 2, so exit 3 was read as a rejected invocation and the finding vanished. The table now accepts 3, pinned by `tests/clients/dispatch/runners/captured-real-output.test.ts` against bytes captured from Dart 3.13.5.
