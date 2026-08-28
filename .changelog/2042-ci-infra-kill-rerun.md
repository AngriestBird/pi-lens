---
section: Fixed
---

- **Rerun externally killed CI Unit tests once (refs #2042)** — a completed CI run now classifies the failed Unit-tests log and reruns only failed jobs when the verdict is `infra-kill`. A per-head-SHA marker and the workflow run-attempt gate prevent rerun loops, while classification errors produce an explicit PR comment.
