---
section: Fixed
---

- **Unify test filename classification (refs #2928)** — Apply the shared classifier to runner skip gates and word-index relevance, including Go, PHP and Ruby test names. Preserve vendor penalties and fixture/mock skip rules; recognize direct children of `__tests__`. `isTestFile` (secrets scanner, dispatcher, tree-sitter runner, and the pass-through-wrappers/async-noise/placeholder-comments rule gates) now also applies file-role's directory policy — `/spec/`, `/specs/`, and a bare `test`/`tests`/`spec`/`specs` directory segment (`my-test/`, `integration-test/`, `e2e_tests/`), case-insensitively — which its own deleted arms never covered.
