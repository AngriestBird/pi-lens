---
section: Fixed
audience: user
---

- **`.tfvars` no longer reported as "Unexpected attribute" under terraform-ls** — pi-lens opened every `.tf` and `.tfvars` file in terraform-ls with the language id `terraform`, so a variables file was decoded as module code and, with terraform-ls's enhanced validation (its default since 0.32), every assignment in a `.tfvars` was reported as an error even though `terraform validate` accepts the file. `.tfvars` is now announced as `terraform-vars` — the file association VS Code's extension uses (hashicorp/vscode-terraform#1672) — while keeping the same `terraform` server, runners, and formatter. Any of a variables file's basenames (`variables.tfvars`, `test.tfvars`, `dev.tfvars`, …) benefit.