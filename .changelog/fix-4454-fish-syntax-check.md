---
section: Fixed
audience: user
---

- **A fish syntax error now reaches the agent as a blocking finding (#4454)** — `fish_indent --check` never reports a syntax error: it exits 0, silently, on a missing `end`, an unterminated quote and a stray `end` in a formatted file. The fish-indent runner now also runs `fish --no-config --no-execute <file>`, which parses without executing anything, and reports each error as a blocking `fish-syntax-error` on the real file and line. A file that is merely unformatted still gets only the non-blocking `fish-indent-unformatted` warning, and a valid formatted file gets no finding. When `fish` is not found next to `fish_indent`, the format check still runs and one `fish-syntax-check-unavailable` degradation row says syntax errors are not being checked. This supersedes the note in the #4453 entry that a well-formatted fish file with a syntax error passes silently. Checked on fish 3.3.1 (Ubuntu 22.04) and 4.9.3 by captured output, and on 3.7.0 and 4.2.1 by review probes. fish 3.1 rejects `--no-config`, so there the syntax check is skipped and leaves a `runner-empty-result` row.
