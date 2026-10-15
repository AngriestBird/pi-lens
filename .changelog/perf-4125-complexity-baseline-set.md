---
section: Changed
audience: user
---

- **Per-file complexity baselines no longer stay in memory for the whole session** (#4125). The tool_call memo kept every file's full complexity result and only ever asked whether a path was present. It now keeps the path alone, which measured 28.0 MB down to 2.4 MB retained at 900 files.
