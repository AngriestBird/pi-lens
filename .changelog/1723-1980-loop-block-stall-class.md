---
section: Changed
---

- **Split `loop_block` into compute and non-CPU stalls, and name the sweep that caused one (refs #1980, #1723)** — every `loop_block` record now carries `stallClass` (`below-floor`, `cpu-accounted`, `non-cpu-stall`, `system-stall`) and `cpuCoverageRatio`, derived from the `windowCpuMs` that has sat unread beside `durationMs` since #1122. Nine of sixteen genuine 5s+ blocks in a 23h window burned less CPU than the block lasted; those now read as parked, not as work. `suspectSystemStall` is unchanged. The LSP workspace-diagnostics sweep's per-file touch is also bracketed now, so a block inside it names `lsp_workspace_diagnostics_touch` instead of arriving anonymous.
