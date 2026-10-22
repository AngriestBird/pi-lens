---
section: Fixed
audience: user
---

- **`.tfvars` no longer reported as "Unexpected attribute" under terraform-ls** — pi-lens opened every `.tf` and `.tfvars` file in terraform-ls with the language id `terraform`, so a variables file was decoded as module code and, with terraform-ls's enhanced validation (its default since 0.32), every assignment in a `.tfvars` was reported as an error even though `terraform validate` accepts the file. `.tfvars` is now announced as `terraform-vars` — the file association VS Code's extension uses (hashicorp/vscode-terraform#1672) — while keeping the same `terraform` server, runners, and formatter. The false report is gone for every variables-file basename. terraform-ls (0.39.0) publishes a variables file's real diagnostics only for autoloaded names (`terraform.tfvars`, `*.auto.tfvars`); other basenames (`variables.tfvars`, `dev.tfvars`, …) now get no terraform-ls diagnostics at all.
