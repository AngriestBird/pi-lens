---
section: Fixed
audience: user
---

- **read_symbol and module_report warn when a file has syntax errors (#4949)** — Tree-sitter recovers from syntax it cannot parse and drops declarations, so a `read_symbol` or `read_enclosing` miss in such a file read as "not there". A miss, and every `module_report`, now carries "Syntax errors in this file (tree-sitter recovered); the symbol list may be incomplete." A `read_symbol` hit and a clean file are unchanged.
