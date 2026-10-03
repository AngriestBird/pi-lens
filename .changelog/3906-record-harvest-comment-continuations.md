---
section: Fixed
audience: internal
---

- The PR body check's runtime scan now reads the whole post-image the diff names (the working tree, or `HEAD`) and lexes it once with the shared block-comment lexer, intersecting the records and decision branches it finds with the hunk's added POST-image lines. Because the `/**` opener is present in the real file, a JSDoc continuation (` * name(...) {`) is no longer mistaken for a generator head: a prose `recordDegradationOnce(...)` in a comment no longer satisfies the check, and a real record below a formatter-stable `*/* comment */ entries()` generator head is no longer blanked away. A post-image that is missing, oversize, or does not match the diff's own added text is refused visibly as inconclusive, never a false clean (#3906).
