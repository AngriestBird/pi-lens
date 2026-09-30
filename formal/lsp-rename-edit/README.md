# LSP rename edit model

A TLA+ model of a language server's `WorkspaceEdit` being applied to files
that may have changed since the server computed it (#3803 lane L3). It
covers `lsp_navigation` `rename` with `apply: true`, which #3736 bound over
four rounds, and `rename_file`'s `workspace/willRenameFiles` edits (#3734).
The `TLA+ models` CI job checks every config here against its `\* expect:`
line (see `formal/file-locks/README.md`).

Provenance rows cite master at `cf1b548e5`.

## What the model covers

- **The server's view** of each file the edit writes text to:
  - an **opened** file (the client holds a send record) is the last send.
    Sends and the request share one connection, so the server computes from
    the sends made before the request;
  - an **unopened** file is the copy the server read **at project load**.
    The initial state is the loaded project, so every later write comes
    after the load. This is the #3736 round-3 lesson: tsserver reads
    unopened files at load, not after the request.
- **The `rename` flow** (`tools/lsp-navigation.ts`):
  1. `Prepare`: `openFileBestEffort` reads the target and sends it
     (`tools/lsp-navigation.ts:696`).
  2. `Request`: `T` is taken just before the request
     (`tools/lsp-navigation.ts:1598`), and the server computes from its view.
  3. `Capture`: `captureRenameExpectedContent` binds each file
     (`tools/lsp-navigation.ts:761`).
  4. `ApplyEdit` (`tools/lsp-navigation.ts:1613`).
- **The `renameFile` flow** (`LSPService.renameFile`,
  `clients/lsp/index.ts:8288`): `willRenameFiles` (`Request`), the merged
  text edits applied with no `expectedContent` (`clients/lsp/index.ts:8381`),
  then `didClose` and the resource move (`clients/lsp/index.ts:8520`). Either
  can fail after the text edits (`Abort`, which throws at
  `clients/lsp/index.ts:8512` for `didClose`).
- **The send-change stamp** (`changedAtMs`): a send moves it only when the
  bytes change (`clients/lsp/client.ts:2211`). A first `didOpen` has no
  previous record, so it always stamps.
- **Writers:**
  - `PiWrite`: pi's queued writers, meaning the agent's `edit` and `write`,
    and the formatter since #3610. Each write is followed by a `touchFile`
    sync (`PiSync`) that can land late or never. The pipeline syncs in its
    step 4 (`clients/pipeline.ts:1892`), after the format and fix steps
    (`clients/pipeline.ts:1719`), and never syncs a file over the size
    limit (`clients/pipeline.ts:1278`);
  - `ExternalWrite`: no queue and no sync. With `KeepMtime`, the write may
    keep the file's old mtime (`cp -p`, `utimes`). With `WatcherPrompt`, the
    server's own file watcher delivers it at once for an unopened file;
  - `Touch`: a read auto-touch or a cascade touch sends the disk bytes with
    no write. For an unopened file it is the `didOpen`.
- **`ApplyEdit`** is one step: under the queues of every touched path,
  compare each expected content with the disk before any write, refuse the
  whole edit on a mismatch, and otherwise write every file
  (`clients/lsp/edits.ts:1475`, the preflight at `clients/lsp/edits.ts:1483`,
  the compare at `clients/lsp/edits.ts:1237`, the write at
  `clients/lsp/edits.ts:1508`).

### The `LspEdit` writer belongs to lane L5

Lane L5 owns the `LspEdit` writer, in `formal/dispatch-pipeline`. It had not
landed when this family was written, so `ApplyEdit` here is an abstract step
with the same contract: compare under the queues, then write, with no queued
writer in between. A step between the compare and the write, which an
unqueued writer could enter, is L5's to model (the split compare and write
and `MutLspEditNoQueue`). When L5 lands, `ApplyEdit` should cite its action
by name and stay one step here.

### Capture rules (`Rule`)

| Rule | Target | Opened non-target | Unopened non-target | Code |
|---|---|---|---|---|
| `none` | not bound | not bound | not bound | before #3736; `renameFile` on master |
| `targetOnly` | bytes `Prepare` read | not bound | not bound | #3736 round 1 (`1fbc52f4d`) |
| `r2` | same | refuse if disk differs from the last send | refused | round 2 (`92d14c0c6`) |
| `r3` | same | as `r2` | refuse if mtime is at or after `T - Margin` | round 3 (`c64b10a8f`) |
| `merged` | same | as `r2`, and refuse if the send changed at or after `T` | as `r3` | round 4, master (`tools/lsp-navigation.ts:798`, `:806`, `:811`) |

A file that passes is bound to the bytes the capture read, and the apply
refuses it if the disk no longer holds them.

## Invariants

- `NoStaleApply`: every file the edit wrote held the bytes the server
  computed the edit from.
- `AtomicRefusal`: a refused or aborted operation wrote nothing.
- `NoUnexplainedRefusal`: a refusal means a touched file was written after
  the operation began, or differed from the server's view at the request.
  The only other refusals allowed are the two false refusals #3736 accepts
  from a coarse clock (`AcceptedFalseRefusal`): a changed send stamped in
  `T`'s own tick (the `>=` tie), and an unopened file whose mtime is within
  the margin of `T`. Without this invariant, a rule that refuses everything
  would pass, and round 2's defect would be invisible.
- `NoAppliedAfterWrite` is a reachability witness, checked only by
  `MergedWitness`.

## Results

TLC 1.7.4, one worker. Constants shared by every config: `Margin = 1`,
`MaxWrites = 2`, `MaxClock = 4`; the clock starts at `Margin + 1`, so an
untouched file is older than the margin.

| Config | Verdict | Distinct states |
|---|---|---|
| `Merged` | pass | 29586 |
| `MergedWitness` | `NoAppliedAfterWrite` violated (non-vacuity) | 2844 |
| `PreFix` | `NoStaleApply` violated | 475 |
| `R1TargetOnly` | `NoStaleApply` violated | 176 |
| `R2RefuseUnopened` | `NoUnexplainedRefusal` violated | 122 |
| `R3HashOnly` | `NoStaleApply` violated | 393 |
| `R3MtimeAtLoad` | `NoStaleApply` violated | 237 |
| `Issue3747External` | `NoStaleApply` violated | 237 |
| `Issue3747KeepMtime` | `NoStaleApply` violated | 229 |
| `Issue3747LateHookSync` | `NoStaleApply` violated | 668 |
| `Issue3747PromptWatcher` | pass | 375 |
| `MergedFirstOpenTouch` | `NoUnexplainedRefusal` violated | 80 |
| `Issue3734Master` | `NoStaleApply` violated | 65 |
| `Issue3734Bound` | pass | 1471 |
| `Issue3734Abort` | `AtomicRefusal` violated | 120 |

### Provenance

"master" is today's code, "pre-fix" is code before a #3736 round, and
"candidate" is a fix that has not been written.

| Config | Issue | Provenance | Shortest counterexample |
|---|---|---|---|
| `Merged` | #3601, #3736 | master: target and opened files bound (`tools/lsp-navigation.ts:798`); pi writes, external writes and touches of the target and an opened file; an unopened file that nobody writes | none (pass) |
| `PreFix` | #3601 | pre-fix: no `expectedContent` before #3736 | `Prepare`, `Request`, `Capture`, a pi write to the target, `ApplyEdit` over it. |
| `R1TargetOnly` | #3736 round-1 review F1 | pre-fix: round 1 (`1fbc52f4d`) binds only the target | The same, with the write to the opened non-target file. |
| `R2RefuseUnopened` | #3736 round-2 decision | pre-fix: round 2 (`92d14c0c6`) refuses every unopened file | `Prepare`, `Request`, `Capture` refuses the quiet unopened file. No write happened. |
| `R3HashOnly` | #3736 verify r3 V1 | pre-fix: round 3 (`c64b10a8f`) checks only that the disk equals the last send | `Prepare`, `Request`, a pi write to the opened file, its sync, `Capture` (disk equals the last send), `ApplyEdit`: the server computed from the send before. |
| `R3MtimeAtLoad` | #3736 verify r3 V2 | pre-fix: round 3's mtime rule, with the server reading at load | An external write to the unopened file, two ticks, `Request`, `Capture` (mtime older than the margin), `ApplyEdit`. |
| `Issue3747External` | #3747 (open) | master: the same trace under round 4, whose unopened rule is round 3's | As `R3MtimeAtLoad`. |
| `Issue3747KeepMtime` | #3747 (open) | master, with a prompt watcher | `Prepare`, `Request`, an external write that keeps the old mtime, `Capture`, `ApplyEdit`. |
| `Issue3747PromptWatcher` | #3747 boundary | master, with a prompt watcher and honest mtimes | none (pass) |
| `Issue3747LateHookSync` | #3747 (open), model finding | master: pi's own write to an unopened file, its sync still pending | `Prepare`, a pi write to the unopened file, two ticks, `Request` with the sync pending, `Capture` (unopened, mtime older than the margin), `ApplyEdit`. |
| `MergedFirstOpenTouch` | model finding (safe) | master: a first `didOpen` always stamps (`clients/lsp/client.ts:2211`) | `Prepare`, `Request`, a touch that first opens the unopened file (same bytes), `Capture` refuses it on the stamp. |
| `Issue3734Master` | #3734 (open) | master: `renameFile` applies with no `expectedContent` (`clients/lsp/index.ts:8381`) | `Request` (`willRenameFiles`), `Capture` (nothing bound), a pi write, `ApplyEdit`. |
| `Issue3734Bound` | #3734 | candidate: the #3736 rule, with `T` taken before `willRenameFiles` | none (pass) |
| `Issue3734Abort` | #3734, model finding | master order, even with the candidate binding: text edits, then `didClose` and the move (`clients/lsp/index.ts:8512`, `:8520`) | `Request`, `Capture`, `ApplyEdit` writes both files, `Abort`: the rename is reported aborted with the edits written. |

## Findings

1. **The merged behaviour passes** for the target and every opened file
   (`Merged`), with pi writes, external writes, mtime-kept writes and
   identical re-touches. `NoStaleApply` and `AtomicRefusal` hold, and it
   refuses only when a file changed.
2. **#3747 is three traces, not two.** The issue names the missed external
   write (`Issue3747External`) and the mtime-kept write
   (`Issue3747KeepMtime`). The model adds pi's own write to an unopened
   file whose `touchFile` sync has not run by the capture
   (`Issue3747LateHookSync`). #3736's state table assumed that sync precedes
   the request. The pipeline syncs after its format and fix steps, and never
   syncs a file over the size limit, so a rename in a parallel tool call can
   compute from the load copy while the mtime is older than the margin.
   This trace comes from the model and a code reading; it has not been
   reproduced on a real server.
3. **#3747's boundary:** with a watcher that delivers at once and honest
   mtimes, the mtime rule holds (`Issue3747PromptWatcher`). This is why
   #3736 round 4's probes applied correctly on one machine, while verify r3
   corrupted `b.ts` on another.
4. **A false refusal on master (safe).** A read or cascade touch that first
   opens an unopened file after `T` stamps it (a first `didOpen` has no
   previous record), so the rename is refused with "it changed after the
   language server computed the rename from it", although no byte changed
   (`MergedFirstOpenTouch`). A retry passes.
5. **#3734:** binding the `willRenameFiles` edits with the #3736 rule closes
   the stale apply for opened files (`Issue3734Bound`; unopened files then
   inherit #3747). Binding alone does not make `rename_file` atomic:
   `renameFile` writes the text edits before `didClose` and the resource
   move, and a failure in either aborts with the importers already
   rewritten (`Issue3734Abort`).

## Soundness notes and scope

- **The server's own watching of unopened files is not modelled** (except
  `WatcherPrompt`'s instant delivery). Watching only moves the server's
  copy toward the disk. `Capture` and `ApplyEdit` never read the server's
  view, so a watch delivery cannot turn a correct apply into a stale one;
  leaving it out keeps every stale trace and drops none.
- **Content ids are fresh per write**, so a write never restores earlier
  bytes (no A-B-A). All comparisons are per file.
- **`Capture` is one step.** Each file's check reads only that file, and
  the apply compares every bound file again, so interleaving writes between
  the per-file reads adds no behaviour.
- **The margin** only adds refusals, so it cannot hide a stale apply. It is
  modelled to place `Issue3747LateHookSync` past it and to state the
  accepted false refusals exactly.
- **One edit covers every file in `Files`.** The server's per-file choice
  of which files to touch is not modelled.
- Not modelled: #3736's residuals (b) (a swallowed target `touchFile`), (c)
  (two clients tracking one file), (d) (a backward clock step) and (e)
  (symlink spellings); the post-apply resync; diagnostics.
