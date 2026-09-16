---
section: Fixed
---

- **Recognise regex literals in the indentation template-lexer's conservative state (refs #3120)** — `advanceTemplateState` had no notion of a regex literal, so a backtick inside one (`` /`/ ``) opened a phantom template frame and a `/*` inside one (`` /[/*]/ ``) pushed a phantom block frame that never finds its closing `*/`; both silently disabled template-interior masking for the rest of the file. `/` is now recognised as a regex opener only in unambiguous grammar positions (after `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `}`, `;`, a `return`/`typeof`/`case` keyword, or line start) and skipped whole to its own unescaped closing `/`, honouring `[...]` character classes and `\` escapes — division stays division everywhere else, unchanged from before. A 17,833-file `node_modules` corpus re-run shows zero files newly declined and no new `width 1` verdicts; 8 files improved (3 resolved from `decline` to `space/2`, 5 corrected from `space/4` to `space/2`).
