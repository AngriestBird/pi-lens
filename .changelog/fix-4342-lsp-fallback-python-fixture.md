---
section: Fixed
audience: internal
---

- The review graph LSP symbol fallback test (#4342) parses a `.py` fixture instead of `lib/main.dart`. Dart is not a core grammar, so a cold grammar cache sent the test to the CDN, and a stalled fetch timed it out at 5 s on a loaded shard. Python is core and still reaches the zero-symbol fallback.
