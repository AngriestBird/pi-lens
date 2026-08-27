---
section: Fixed
---

- **Rename the CI classifier's kill label to infra-kill and read kernel evidence (refs #2103)** — every exit-137/SIGKILL kill used to post as `infra-oom` even with memory headroom; the classifier now labels it `infra-kill` and enriches the detail with the kernel kill-evidence step's dmesg/cgroup output already in the log.
