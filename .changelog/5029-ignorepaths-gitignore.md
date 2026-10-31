---
section: Changed
audience: user
---

- **`rules.<id>.ignorePaths` now matches like the `ignore` field** — entries follow gitignore rules, relative to the `.pi-lens.json` that declares them: the last matching entry wins, `!` re-includes a path an earlier entry carved out, a leading `/` roots the entry at that file's directory, and a trailing `/` names a directory. Before, every entry was a plain glob, so a `!legacy/keep.ts` entry hid every path its glob did not name, and `/legacy/**` and `legacy/` matched nothing. Entries with a slash keep their meaning; a slashless entry such as `*.gen.ts` now also matches below the root, and a line starting with `#` is a comment. Each config file stays its own scope, so a `!` re-includes only against its own file's entries and never lifts a carve-out another file (or the global config) declared (refs #5029).
