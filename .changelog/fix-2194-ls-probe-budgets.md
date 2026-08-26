---
section: Fixed
---

- **Bound the JSON and Bash language-server verification probes (closes #2194)** — `bash-language-server` and `vscode-json-language-server` measured 9,667ms and 11,047ms cold `--version` starts with closed stdin, close enough to the 10-second installer default that host contention alone could trip a false verification degradation. Both now carry a 20-second `verificationTimeoutMs`, delivered through the managed-local, install, and refresh paths. The refresh delivery for the other five install strategies (pip, gem, github, maven, archive) is now covered by tests too, closing the gap the issue's follow-up comment flagged.
