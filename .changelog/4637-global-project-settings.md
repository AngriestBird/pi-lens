---
section: Fixed
audience: user
---

- **Name project-only settings in global config warnings.** Valid project settings such as `rules` and `reviewGraph` now point to `<project>/.pi-lens.json` instead of being described as typos. Unknown keys still receive the typo warning. (closes #4637)
