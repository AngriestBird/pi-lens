---
section: Fixed
audience: user
---

- **A crashed or timed-out shellcheck, shfmt or fish_indent no longer reads as a verdict on the file; ktlint findings are read again (refs #4522)** — shellcheck reported a clean file when it was killed or timed out, and shfmt and fish_indent reported a parse error or an unformatted file; each now reports no verdict. ktlint 1.8.0 prints a log line before its JSON report and names the fields `column`, `message` and `rule`, so its findings came out as a parse error or as `[undefined] undefined`. A tool-state matrix over every runner with captured real output now holds the line: only a clean run may read clean.
