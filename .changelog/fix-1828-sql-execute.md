---
section: Fixed
audience: user
---

- **`no-sql-in-code` and `no-sql-in-code-js` now cover `.execute()` calls (closes #1828)** — SQL built by string concatenation or `${...}` substitution and passed to `db.execute(...)` or `db?.execute(...)` now flags when the SQL text starts with a statement such as `SELECT ... FROM`, `UPDATE ... SET` or `DELETE FROM`. This is the statement-prefix test the TypeScript `sql-injection` rule gained for #2909, with three changes: `SELECT` and `WITH` must be whole words, the escapes `\n`, `\r` and `\t` (exactly those, case-sensitive) before the statement are skipped like real whitespace, and a `--` comment before it may end at an escaped `\n`. It keeps non-SQL calls such as `runner.execute("delete " + id)` and `job.execute("selected from " + source)` quiet. Literal SQL, parameterized `execute(sql, [id])` calls and tagged templates such as Drizzle's `sql` stay quiet. `db.query(...)` matching is unchanged.
