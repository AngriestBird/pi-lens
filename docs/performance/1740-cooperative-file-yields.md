# Cooperative scan and graph extraction: measured evidence

Investigation date: 2026-10-15. This change addresses measured members of
[apmantza/pi-lens#1740](https://github.com/apmantza/pi-lens/issues/1740), not the
whole issue. Baseline engine: `f62d3ffb58bfea0bce271cba8e2349469e1062d0`.
Implementation commit: `8ddeec0` (the five-file patch).

The scanner now yields to host callbacks after releasing each completed file's
facts. Full graph extraction uses the existing yield helper after checkpoint
bookkeeping. No rule filtering, cache policy, deadline or exported API changes.
Individual native operations and graph finalization remain synchronous.

## Environment and method

Linux x86_64, Xeon Platinum 8370C, five visible CPUs with a four-CPU cgroup quota,
16 GiB memory limit, Node 24.19.0, npm 11.9.0. Runs were headless and sequential;
no paid inference. Fresh means fresh process/application cache, not cold OS
filesystem pages. Profiled runs are excluded from timing samples.

Both engines used identical frozen source fixtures from
`eb459bc89b52187eea1e2fedbd90fbb48cd90a51`: 250 sorted TypeScript files under
`clients/` (3.53 MB, 249 graph-admitted sources), and a tracked repository archive
(717 graph-admitted sources). These are bounded samples, not production SLAs.
Controlled full-rebuild runs flush persistence, wait for workers, clear the
memory cache, and remove only their private persisted graph before rebuilding.
An initial after-run that loaded a persisted graph was excluded and retained in
the local investigation archive.

## Measurements

Each row's sample count applies separately to each engine. Gaps are ranges of
per-run maximum host-event-loop gaps, not p95 estimates.

| Work | Samples | Before median wall | After median wall | Before gap | After gap |
| --- | --- | --- | --- | --- | --- |
| TS scan, fresh | 3 processes | 23.32 s | 23.02 s | 23.02–31.87 s | 1.50–1.82 s |
| TS scan, warm | 2 passes | 21.98 s | 21.48 s | 21.70–22.17 s | 1.32–1.39 s |
| Small graph, fresh | 2 processes | 3.43 s | 3.61 s | 3.12–3.46 s | 253–257 ms |
| Small graph, warm full rebuild | 4 passes / 2 processes | 2.15 s | 2.26 s | 2.02–2.26 s | 155–235 ms |
| Repository graph, fresh | 2 processes | 13.60 s | 14.02 s | 11.00–11.09 s | 297–378 ms |
| Repository graph, warm full rebuild | 4 passes / 2 processes | 11.45 s | 12.63 s | 10.12–12.72 s | 319–445 ms |

Responsiveness improves, while graph median wall cost rises about 3–10% in this
sample. Cloud variance and small counts prevent a precise causal throughput
estimate. Persistence can now make progress during extraction.

Public stdio MCP, three fresh processes per engine: worst unrelated ping delays
were **3045/3608/3623 ms before** and **175/125/133 ms after**. All final project
reports completed. Sequential-ping percentiles are not comparable tail estimates:
before the change, most requests followed one blocking build; afterward, early
requests contended with ongoing work.

Ordered diagnostic and graph-content SHA-256 values match across versions:

- 1187 diagnostic rows: `7793c6643bc79200a9e60a7195d66cdf426705d8889944c2dbc68e95dd91a7d5`.
- Small graph: `d4ebb02cd4a5420a3f17462f56e52e9500ddd1f170976b1a905776c52061bd8e`.
- Repository graph: `fbbdaf0353d793a3e48e0b97ae88f11c85f4e6523ef83baf39d4636509d9b2ec`.

Graph hashes cover ordered nodes, edges, file/symbol/changed-symbol maps, excluding
timestamps and generations. Post-flush/cache-clear/GC heap is approximately
78.2–78.5 MiB on both engines across six boundaries each; this is not a leak proof.
A separate scan CPU profile attributes about 59% of leaf samples to ast-grep rule
evaluation. A direct evaluator probe spends 13.05/14.12 seconds in native findAll.
No native-rule optimization is claimed. Linux does not validate Windows behavior.

## Validation and limits

- Relevant scanner/graph suites: 13 files, 76 tests passed.
- Final isolated regressions, await census and temporary-fixture hygiene:
  three files, 70 tests passed.
- The six new real-path regressions fail on the actual baseline. Replacing either
  new macrotask yield with a ready promise fails its three corresponding cases;
  the other three remain green. Mutations were automatically restored.
- The await census registers exactly the added graph await, 42 to 43. Its updated
  expectation fails against the unchanged baseline. No predicate was weakened.
- Typecheck, full lint, builds, formatting, changelog and local body lint passed.
- Independent Sol review found no demonstrated implementation blocker.
- The disabled-primary LSP test's five-second timeout is **RED-ON-BASE**, established
  by the repository's canonical comparison tool.
- A distinct missing JSON-start marker once failed while its diagnostic verdict
  remained confirmed-clean. Controlled follow-up passed that assertion **6/6 on
  each engine**: four isolated runs and two after the preceding timeout. The timeout
  reproduced in all four paired cases. No process exceeded its 90-second bound.
  The original marker failure remains **unattributed**, not proven unrelated.
- The first aggregate lane's selected registry and governance batches both
  completed, in 362.94 and 186.88 seconds. The outer 600-second budget interrupted
  the aggregate gate before a final verdict. Its 111-file selection exceeded the
  25-file cap. That run also overlapped scratch cleanup with another LSP invocation;
  the subsequent isolated hygiene checks passed. No 600-second hung scan was shown.

Overall validation remains **unproven**, not an all-green or merge-ready claim.
The patch references #1740 and does not resolve all CPU-bound work. It does not
repeat #2066, #4125, or the merged #4460–4463 changes.

## Reproduce the checks

After normal repository dependency/grammar setup and `npm run build`, use a fresh
private TMPDIR and run these headlessly. Do not externally set PI_LENS_HOME or
PILENS_DATA_DIR for Vitest; test setup owns them.

```sh
npm run test:targeted -- tests/clients/bulk-file-yields.test.ts tests/config/hook-await-bounds.test.ts tests/config/tmp-fixture-hygiene.test.ts
npm run test:targeted -- tests/tools/diagnostics-route-switch-matrix.test.ts -t 'starts the same servers and gives the same verdict on every route: present, no aux$'
node scripts/red-on-base.mjs tests/tools/diagnostics-route-switch-matrix.test.ts --base f62d3ffb58bfea0bce271cba8e2349469e1062d0 --repeat 2
```

For performance reproduction, create the same frozen fixtures from `git archive`
and compare the baseline with the implementation commit. Call `projectScan(cwd,
300)` from `clients/lens-engine.js`, or `buildOrUpdateGraph(cwd, [], new FactStore())`
from `clients/review-graph/builder.js`. Sample host progress with a recurring
`setImmediate`, recording the maximum interval; capture wall time, process CPU,
output content hash and memory. Use fresh private application data per process;
assert `getGraphBuildInfoForGraph(result).mode === "full"` for full-build samples.
Repeat fresh processes and distinguish cached reads from warm full rebuilds.
Use separate `node --cpu-prof --heap-prof` runs for attribution, not timing.
Retain raw samples rather than deriving tail percentiles from two or three builds.

The original five-file transfer patch SHA-256 is
`7710ba51ef3df3ce105847c8316e9243eb29cbc9e5128009b126af8720e14165`.
Raw profiles and transcripts remain in the saved investigation environment; this
public report contains the relevant measurements and limitations without local
account data, session links or unrelated workspace content.

## Final aggregate check before fork publication

A new serial invocation with a fresh private TMPDIR and a 900-second outer bound
**completed**, returning the repository's final **unproven (exit 3)** verdict.
It checked implementation commit `8ddeec0f862a473f8af963b4d91901ab116db22d`
with the report and ignore-list exception still present as working-tree edits.

- Selected registry batch: 46 files, 919 tests passed, 30 skipped, one failed test
  and one failed suite; duration 389.08 seconds. The selector matched 111 test
  files, above its 25-file cap, so this is incomplete coverage.
- Governance: **163 files passed; 2710 tests passed, one skipped**, 150.23 seconds.
- The disabled-primary LSP timeout was again **RED-ON-BASE** against exact baseline
  `f62d3ffb58bfea0bce271cba8e2349469e1062d0`.
- `availability-policy-coverage.test.ts` initially exceeded its 10-second
  `beforeAll` setup limit while scanning client sources. It passed in governance
  and did not reproduce in the attribution rerun. The final classifier labels it
  **INCONCLUSIVE**, not unrelated. No deadline or assertion was weakened.
- Build, body lint, changelog, touched-source formatting, ast-grep self-scan and
  dependency checks returned zero. Dependency-cruiser warned that installed
  TypeScript 7 is outside its supported transpiler range, so that check may omit
  TypeScript dependencies; its zero exit is not a complete dependency proof.
- The prior intermittent JSON-start-marker failure remains unattributed despite
  the controlled 6/6 passes on each engine. It did not recur in the final selected
  batch. No patch-caused failure was demonstrated by automatic attribution.

This completes the bounded aggregate attempt without claiming a green lane.
No additional production changes were justified. The fork branch preserves the
five-file implementation and adds only this report plus its exact ignore-list
exception. Publication is for review; no PR, merge, master update or deployment
is included.
