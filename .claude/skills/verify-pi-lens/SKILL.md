---
name: verify-pi-lens
description: Drive a built pi-lens through its real MCP or tool layer, with home and data dirs pinned under the lane TMPDIR, to verify LSP diagnostics with a real server (Pyrefly), the formatter, the review graph and rename_file, on the checkout or on any other commit. Use when a fix or review needs a real-path probe, not a mock, and a model run (scripts/run-harness.mjs) is too costly.
---

# Verify pi-lens

> Procedure only. Role rules (what a reviewer or fixer must prove, and how)
> live in `docs/pi-lens-reviewer.md`, `docs/pi-lens-fixer.md` and
> `docs/pi-lens-subagent.md`; on any conflict they win. This skill replaces
> probes rebuilt per lane, which vanished with the worktree (#4359).

Shape after the create-verification-skill pattern: Launch, Doctor, Drive,
Evidence, Cleanup, Helpers, and a features map.

## Launch

Linux or macOS with `node`, `git` and `uv`. Everything a run writes lands under
the lane `TMPDIR`; `env.sh` refuses `/tmp`.

```sh
export TMPDIR=~/.local/share/pi-lens-orchestrator/tmp/<lane>-tmp
S=.claude/skills/verify-pi-lens/scripts
npm run build                      # the tree under test must be built
$S/setup.sh pyrefly                # once: Pyrefly 1.3.2 + ruff venv (py-venv)
. $S/env.sh                        # pins HOME, PI_LENS_HOME, PILENS_DATA_DIR, XDG, uv cache
```

`env.sh` sets `RUN` (disposable) and `EVIDENCE` (kept). Source it in every
shell call: agent shells reset their environment between calls.

The server under test is the real stdio MCP server, `mcp/server.js`, launched
inside the scenario workspace as a host would. To verify a commit other than the
checkout (the base, or the commit before a fix), build it first and pass it as
`--tree`:

```sh
OLD=$($S/setup.sh tree <rev>)      # git archive + build under $VERIFY_ROOT/trees
```

## Doctor

```sh
node $S/verify.mjs doctor --tree "$PWD"      # or --tree "$OLD"
```

Read-only on the tree. It checks the env pins, that the compiled twins are not
older than their sources, that the Pyrefly venv exists, that `tools/list` serves
the driven tools, and that `pilens_health` answers with tree-sitter available
and no degradations or broken servers. Alive is not usable: do not drive past a
`FAIL`.

## Drive

```sh
node $S/verify.mjs drive <scenario> [variant] --tree "$PWD"
```

Exit 0 when every expectation holds. Output lines are `PASS`, `FAIL`, `KNOWN`
(a residual an open issue owns: not a failed verdict) and `XPASS` (the residual
no longer reproduces: say so, the issue's acceptance may hold). Each feature file
below lists its scenario, variants, the user goal and the exact checks. Write
the report from the `PASS`/`FAIL` lines; quote them.

To prove a fix, run the scenario on the commit before it and on the fix:
`FAIL` on the first with the defect's own line, `PASS` on the second.

## Evidence

`$EVIDENCE/<scenario>-<variant>/` (a sibling of `$RUN`, so cleanup keeps it):

- `mcp-wire.jsonl`: every JSON-RPC frame, timestamped, plus the server's stderr.
- `lsp-wire.in`, `lsp-wire.out`: both directions of the LSP stream, for the
  scenarios that launch Pyrefly through `pyrefly-tee.sh`.
- `steps.json`: each call's tool, arguments, elapsed ms and full result.
- `summary.json`: the expectations with their details.
- `pi-lens-home/`: the run's pi-lens home with its logs.

Quote paths and lines from these files in the report; copy what the review must
keep to the lane's report directory, since `$TMPDIR` is the lane's, not the PR's.

## Cleanup

`drive` and `doctor` stop their server and kill only the pids they recorded in
`$RUN/pids.json` (pid plus process start time, so a reused pid is never
signalled). When a run died half way:

```sh
node $S/verify.mjs cleanup            # kills this run's recorded pids, removes $RUN, keeps $EVIDENCE
node $S/verify.mjs cleanup --trees    # also drops trees built by setup.sh tree (unlinks node_modules first)
```

Then `pgrep -fa 'pyrefly|mcp/server'` must show none of your servers.

## Helpers

Executable, under `scripts/`; invoke them from this body, never copy them.

| Helper | Role |
| --- | --- |
| `env.sh` | Sourced. Pins HOME, pi-lens, XDG and uv dirs under `RUN`; rejects `/tmp`. |
| `setup.sh pyrefly` / `tree <rev>` | The Pyrefly + ruff venv; a built copy of a commit. |
| `pyrefly-tee.sh` | Registered as the Pyrefly command in the scenario's `.pi-lens/lsp.json`; copies the LSP wire. |
| `verify.mjs doctor` / `drive` / `cleanup` | The driver: MCP client, wire log, pid tracking, expectations. |
| `scenarios/*.mjs` | One module per feature: `variants`, `setup`, `run`. Add a variant here, not a new script. |

Reuse, not duplicated: the shared fake server `tests/fixtures/fake-lsp-server.mjs`
and the vitest harness `tests/mcp/harness.ts` stay the unit-level tools;
`scripts/smoke-tools.mjs --format` is the per-language formatter sweep;
`scripts/run-harness.mjs` is the model-driven end to end (too costly for routine
verifies).

## Features map

| File | Scenario (variants) |
| --- | --- |
| `features/lsp-diagnostics.md` | `lsp-created-module` (`issue`, `importer-first`, `importer-only`, `replay`) |
| `features/rename-file.md` | `rename-file` (`into-missing-path`) |
| `features/review-graph.md` | `review-graph` (`mcp-create-after-build`, `builder-incremental`) |
| `features/formatter.md` | `formatter` (`python-ruff`) |

Each file has the sections Sub-features, How to get to it (user POV), Driving it
with the harness, and Gotchas. Add a feature file when a seam has no recipe, and
add the probe shape of any reviewed defect as a variant of its feature.
