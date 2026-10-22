---
section: Fixed
audience: user
---

- **Terraform diagnostics no longer wait out a hold on the first publish (#4746)** — terraform-ls's first publish carries the file's findings, so the first-publish hold that treated it as an index artifact could only delay them. The probe that measured that hold counted the workspace directory's empty set as the file's own first publish; scoped to the document it reads `direct`, and the hold is removed.
