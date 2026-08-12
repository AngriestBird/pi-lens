# Durable-store cross-process audit (#1202)

Atomic rename prevents torn files; it does not serialize read-modify-write. This
audit classifies stores reachable by extension, MCP, CLI, and subagent processes.
`<project>` means `getProjectDataDir(cwd)` and `<global>` means
`getGlobalPiLensDir()`.

| Store and path | Racing writers | Semantics | Risk | Existing mitigation / decision |
|---|---|---|---|---|
| Turn state — `<project>/turn-state.json` | extension, MCP, CLI; subagents use distinct owners | read-modify-write worklist | (a) impossible | `TurnStateOwner` rejects a foreign live owner; MCP turn-end operations are FIFO-serialized. `0d5f017f` covers the pi/MCP ownership handoff. |
| Scanner caches — `<project>/cache/{scanner}.json` + `{scanner}.meta.json` | extension, MCP, CLI, subagents | overwrite-only scan result + freshness metadata | (b) possible, benign | none; a losing cache publication is recoverable on the next scan. Data is written before metadata, so interruption cannot make old data newly fresh; concurrent last-finisher wins. |
| Rule cache — `<project>/cache/{language}-rules-3.json` | all analysis processes | overwrite-only, content-hash validated | (a) impossible | rule hash rejects a cache for different inputs. |
| Workspace diagnostics — `<project>/cache/lsp-workspace-diagnostics.json` | extension/MCP/CLI sweeps and subagents | read-merge-overwrite cache | (b) possible, benign | mtime/content/dependency freshness rejects stale entries; a lost entry causes a rescan. Accepted benign. |
| Call graph — `<project>/cache/call-graph.json` + `.meta.json` | extension/MCP/CLI graph builds, subagents | overwrite-only derived graph | (b) possible, benign | source freshness validation; a loss rebuilds from source. Accepted benign. |
| Codebase model — `<project>/cache/codebase-model.json` + `.meta.json` | extension/MCP/CLI builds, subagents | overwrite-only derived model | (b) possible, benign | source/file-set validation; a loss rebuilds. Accepted benign. |
| Actionable-warning state — `<project>/cache/actionable-warning-state.json` | dispatches in every process | read-merge-overwrite best-effort cache | (b) possible, benign | warning ids are rediscovered by later dispatch; suppression fields are preserved when observed. Accepted benign. |
| Actionable-warning history — `<project>/actionable-warnings.jsonl` | every dispatcher | append-only telemetry | (b) possible, benign | one append call per batch; malformed/truncated telemetry lines are ignored. Accepted benign. |
| Metrics history — `<project>/metrics-history.json` | session scans and `/lens-metrics` in every process | read-modify-overwrite trend cache | (b) possible, benign | capped derived history; later capture self-heals latest state. Accepted benign. |
| Project diagnostics — `<project>/cache/project-diagnostics.json` and `project-diagnostics-delta.json` | extension/MCP/CLI scans, subagents | overwrite-only derived snapshots | (b) possible, benign | per-file mtime filtering; next scan replaces loss. Accepted benign. |
| Worklog — `<project>/worklog.jsonl` | all dispatchers | append-only best-effort telemetry | (b) possible, benign | OS append operation per batch; readers skip malformed lines. Accepted benign. |
| Widget/read-guard session state — `<project>/sessions/{sessionId}.json` | one extension host per stable session id | overwrite-only session snapshot | (a) impossible | session-id sharding; read guard and widget are co-snapshotted atomically. |
| Diagnostic dispositions — `<project>/cache/diagnostic-dispositions.json` | extension, MCP, CLI tools, subagents | read-modify-write behavior gate | (c) possible, harmful | **fixed here:** exclusive pid lock, in-lock disk re-read, and per-anchor merge refuse stale whole-file promotion. |
| Recent touches — `<project>/recent-touches.json` | every extension/subagent publisher | read-append-overwrite bounded attribution ring | (b) possible, benign | explicitly best-effort nudge attribution; lost entries do not gate edits/checks and later touches replenish it. Accepted benign. |
| Instance registry — `<global>/instances.json` | every host/MCP/subagent process and reaper | read-modify-overwrite observability registry | (b) possible, benign | explicitly best-effort; liveness checks are conservative and missing entries do not authorize killing. Accepted benign. |
| Project snapshot — `<project>/cache/project-snapshot.json.gz` + `.meta.json` | extension/MCP/CLI builders, subagents | monotonic derived snapshot | (a) impossible | durable project sequence/source identity and generation-gated staged promotion; body embeds its seq so mismatched metadata is rejected. |
| Review graph + checkpoint — `<project>/cache/review-graph.json.gz`, `review-graph.checkpoint.json.gz` | extension/MCP/CLI builders, subagents | overwrite-only derived graph | (a) impossible | source signature/project-seq validation plus staged, generation-gated promotion; stale content is rejected on load. |
| Probe cache — `<global>/probe-cache.json` | every installer/prober | read-modify-write tool availability | (a) impossible | existing bounded cross-process lock + in-lock re-read/change merge (#1263). |
| Stop-hook status — OS temp `pi-lens-turn-end-*.json` | concurrent CLI Stop hooks | read-modify-overwrite counters | (b) possible, benign | atomic publication; explicitly bounded best-effort telemetry. Accepted benign. |

The grammar/WASM destination files are immutable content assets, not shared
mutable stores. Atomic staging artifacts are covered separately by the bounded
session-start stage GC and are not authoritative stores.
