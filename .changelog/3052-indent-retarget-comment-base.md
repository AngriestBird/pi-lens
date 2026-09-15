---
section: Fixed
---

- **Stop indent-retarget from basing deeper nesting on a block comment's alignment (closes #3052)** — the edit-tool indentation-mismatch autopatch no longer picks its extrapolation base unit from a JSDoc/block-comment continuation line; it now excludes comment interiors from that pick with the same lexer `indent-detect.ts` uses (#3039), so a comment's alignment ratio can no longer silently mis-scale a deeper-nested replacement. A comment-interior indent still resolves by direct lookup when a replacement reintroduces it.
