---
section: Fixed
---

- **Unify test filename classification (refs #2928)** — Apply the shared classifier to runner skip gates and word-index relevance, including Go, PHP and Ruby test names. Preserve vendor penalties and fixture/mock skip rules; recognize direct children of `__tests__`.
