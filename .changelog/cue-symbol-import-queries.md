---
section: Added
---

- **CUE symbol and import extraction (refs #1522, #1519)** — `.cue` files now get tree-sitter symbol (`#Definition`s as types, struct fields as properties, `let` bindings as variables) and import (`import "pkg"`) queries, so structural symbol search and import extraction cover CUE like any other language instead of falling back to the word index. Definitions are told apart from ordinary fields with a `#match?`/`#not-match?` text predicate on the `#`-prefix, since the grammar has no separate definition node kind.
