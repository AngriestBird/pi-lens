---
section: Fixed
audience: user
---

- **A `pi-lens-ignore` comment or a disposition mark now applies to the file a finding names**: a comment in the edited Helm template no longer hides the blocking `helm-lint` error reported on `Chart.yaml`, on the edit path or in a slow runner's late answer, a mark on one file's finding no longer hides the same finding on another file, and a finding whose file cannot be read or lies outside the project is never suppressed (#5044).
