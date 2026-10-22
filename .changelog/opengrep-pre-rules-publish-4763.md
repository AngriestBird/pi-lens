---
section: Fixed
audience: user
---

- **Opengrep findings now reach the first check of a session (#4763)** — with its default `--config auto`, Opengrep scans a just-opened file before its rules load and publishes an empty result, then sends `semgrep/rulesRefreshed` and the real findings about a second later. pi-lens counted the empty result as Opengrep's answer, so the touch ended with "No auxiliary findings." and the findings arrived after the wait. The empty result is now held until Opengrep says its rules are loaded; the touch waits for the findings within the existing Opengrep budget, and an Opengrep whose rules never load is reported as not having answered instead of as clean. Each `lsp_aux_wait_outcome` row also records `publishedCount`, how many diagnostics the auxiliary published for the touch.
