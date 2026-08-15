---
section: Added
---

- **Attribute worklog and disposition entries to the model/provider that produced them (closes #1448)** — `WorklogEntry` and `DispositionLogEntry` gain optional `model`/`provider` fields, populated at append time from the runtime's telemetry identity (`RuntimeCoordinator.telemetryModelId`/`telemetryProviderId`) and blank when the runtime doesn't know its identity. Provider is the host's explicit value when reported, else a conservative parse of the model id (`clients/model-provider.ts`: a single `/` or `:` separator, or a small known-prefix table; blank on ambiguity — never guessed). `npm run logs:smells` now prints a per-model rollup (rule × model counts, auto-fixed vs. agent-required rates) from `worklog.jsonl`. Old worklog/disposition-log entries stay valid; readers treat both fields as optional.
