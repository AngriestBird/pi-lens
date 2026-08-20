---
section: Fixed
---

- **Search credit ignores pipe truncation (closes #1908)** — `grep -C2 pattern
  file | head -1` no longer credits context lines the pipe cut off. The
  read-guard now detects a truncating pipe tail (`head`, `tail`, `sed q`)
  downstream of a line-numbered grep and falls back to match-line-only
  credit, so a later edit to the uncredited context still requires a read.
