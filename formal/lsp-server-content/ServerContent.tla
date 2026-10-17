--------------------------- MODULE ServerContent ---------------------------
(***************************************************************************)
(* One file N: the content a language server holds for it versus the      *)
(* bytes on disk, across concurrent writers and readers.                   *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - writers w1, w2: an agent write of N (disk write, new mtime), then    *)
(*    that edit's pipeline touch (clients/pipeline.ts readFileSync,        *)
(*    touchFile source "lsp_sync", scope "primary"). Two same-turn         *)
(*    pipelines for one file may run concurrently (write-ordering-guard.ts *)
(*    WriteOrderingGuard);                                                 *)
(*  - the cascade neighbour reader cas (clients/dispatch/integration.ts    *)
(*    computeCascadeForFile readFile, then awaits, then touchFile, scope   *)
(*    primary);                                                            *)
(*  - LSPService.touchFile (lsp/index.ts): startedAt anchored at its start,*)
(*    shouldSkipNotify per server (1500 ms debounce on a                   *)
(*    length+first48+last48 fingerprint), then notify.open, then after the *)
(*    write lands markTouched and recordFullyCoveredSync(startedAt). A     *)
(*    fully skipped touch records nothing;                                 *)
(*  - shouldSkipNotify's EVIDENCE, selected by ContentGate (#4532 gap 9):  *)
(*    "sent" is the client's own record of the payload it last sent        *)
(*    (`getSentContent`, written by client.ts `recordSentContent` in the    *)
(*    SEND's continuation - after the wire write, before the waiters        *)
(*    resolve), compared with the touch's content EXACTLY; the elapsed      *)
(*    window is not read, and a document with no record (never opened, or   *)
(*    closed since) is always pushed. "window" is the pre-#4532 gate (the   *)
(*    1500 ms window plus the whole-text fingerprint); the code runs it     *)
(*    nowhere since round 3, where a client that cannot report a record is  *)
(*    PUSHED instead (`GateWindowReopen` is why). "lossy" is a mutant: the  *)
(*    record compared by fingerprint alone.                                 *)
(*  - #4532 gap 9 round 3 adds the two writers one record cannot settle     *)
(*    alone: the path's notify queue (`hasNotifyInFlight` - the record says *)
(*    what LANDED, so a skip also needs nothing left to send,             *)
(*    `SkipNeedsIdle`) and the save mark (`recent.savedHash`, bound to the  *)
(*    content its didSave went out for, `SaveBoundToContent`). A content    *)
(*    push outside the touch path (`openFile`, `OpenFilePushes`) advances   *)
(*    the record without moving that mark, which is the F2 defect.          *)
(*  - closeDocument (client.ts, #3477): a queue ENTRY, so it waits for a    *)
(*    send in flight; it drops the client's content record and the server's *)
(*    document. `recent` and the drift record survive it, which is what the *)
(*    pre-fix gate could still skip a reopen against;                       *)
(*  - the per-path notify queue (lsp/client.ts enqueueDocumentNotify) an   *)
(*    unstarted entry is REPLACED by the last enqueued one (its waiters    *)
(*    ride along); the runner sends one entry at a time. The check and the *)
(*    send are one step (vscode-jsonrpc orders at send time);              *)
(*  - the drift sweep (lsp/document-drift.ts runSweep): stat, a candidate  *)
(*    when size differs or floor(mtime) > syncedAt; read; equal fingerprint*)
(*    -> re-stamp only ("unchanged"), else resync through touchFile (source*)
(*    drift_resync, scope "all", its own debounce key) and stamp           *)
(*    settledStamp(now, observedMtime) if the record advanced.             *)
(*                                                                         *)
(* Every await is a step boundary. Time is a logical clock advanced on     *)
(* each stamped event, so no two stamps tie (the real floor() tie widens   *)
(* the blind window by 1 ms; not modelled).                                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Writes,       \* 1 or 2 agent writes of N (w1 writes "B", w2 writes "C")
    Cascade,      \* TRUE: a cascade neighbour reader touches N
    EqualLength,  \* TRUE: every version of N has the same byte length
    LossyFp,      \* TRUE: versions differ only in the middle of a >96-char file,
                  \* so the length+first48+last48 fingerprint cannot tell them apart
    Debounce,     \* TRUE: shouldSkipNotify is active (TOUCH_DEBOUNCE_MS > 0)
    ContentGate,  \* which evidence a skip reads: "sent" (the client's record of the
                  \* payload it last sent, exact content, #4532 gap 9), "window" (the
                  \* PRE-#4532 gate: inside the window AND the same fingerprint — the
                  \* code runs it nowhere since round 3, which pushes a client that
                  \* cannot report a record), or "lossy" (a mutant: the record compared
                  \* by fingerprint only)
    RecentA,      \* TRUE: a touch of the initial content landed within the debounce window
    MidClose,     \* TRUE: a didClose may land while another actor can still touch N
    MidSweeps,    \* sweep passes allowed while other actors are still active
    SweepKey,     \* "both" (the code), "size", "mtime": which half of the drift key is compared
    PriorInFlight, \* TRUE: an earlier notify of N (content A) is still being written when the model starts
    FifoLanding,  \* TRUE: co-waiters of one entry finish in enqueue order (JS microtask FIFO)
    FixCoalesce,  \* candidate fix, part 1: a queued entry is only replaced by one read no earlier
    FixDrop,      \* candidate fix, part 2: the runner drops an entry read before the content last sent
    SkipNeedsIdle, \* TRUE (code since #4532 gap 9 round 3, F1): a skip requires the path's
                  \*   notify queue idle, so the landed record is the server's FINAL state.
                  \*   FALSE (code before): the skip reads the record alone, so a send still
                  \*   in flight lands after it and installs the touch's older bytes.
    SaveBoundToContent, \* TRUE (code since #4532 gap 9 round 3, F2): a skipped saved touch
                  \*   sends the save it still owes unless the mark names exactly its own
                  \*   content. FALSE (code before): suppress whenever ANY save was recorded,
                  \*   so a writer that advanced the record without a touch drops one.
    SavedTouches, \* TRUE: a touch declares `saved` (the post-write sync and the dispatch
                  \*   runner do, #3405); FALSE: no touch carries a save
    OpenFilePushes, \* TRUE: a second writer pushes content outside the touch path
                  \*   (`LSPService.openFile`, the resync-on-past-EOF route); FALSE: none
    Revert        \* TRUE: the second writer's bytes are the INITIAL content again, so
                  \*   disk reverts to what the server was sent before. It is what makes
                  \*   F1's lost update harmful: the skipped touch read the bytes disk
                  \*   has NOW, and an in-flight send of older bytes replaces them.

Writers == {"w1", "w2"}
Procs == {"w1", "w2", "cas", "res"}
WriteOf == [w \in Writers |-> IF w = "w1" THEN "B" ELSE (IF Revert THEN "A" ELSE "C")]
Contents == {"A", "B", "C"}
Size(c) == IF EqualLength THEN 1 ELSE CASE c = "A" -> 1 [] c = "B" -> 2 [] c = "C" -> 3
Fp(c) == IF LossyFp THEN Size(c) ELSE c
Max(a, b) == IF a > b THEN a ELSE b

\* `saved` rides the entry (a push carries its save, #3405); `sent`/`recorded`
\* separate the wire write from the record write, in the code's own order
\* (recordSentContent runs after the send lands and before the waiters resolve).
NoEntry == [waiters |-> {}, content |-> "none", seq |-> 0, saved |-> FALSE,
            sent |-> FALSE, recorded |-> TRUE]

VARIABLES
    clock,
    disk, mtime,          \* bytes on disk and their mtime
    server,               \* content the server holds (what was last sent)
    sentRec,              \* the client's record of the payload it last sent for N
                          \* (getSentContent), or "none" when it holds no record
    lastSentSeq,          \* read stamp of the content last sent
    staleSend,            \* a send replaced content read later than the content sent
    pc, content, readAt, startAt, enqAt,
    pending, running,     \* the notify queue: unstarted entry, entry in flight
    record,               \* drift record: [size, fp, at]
    recent,               \* debounce entry for scope primary: [fp, fresh, savedHash]
    skipped,              \* the content a skip certified, or "none" (F1's history)
    serverSaved,          \* the content the server holds a didSave FOR (F2)
    touchedSaved,         \* the content the most recent saved touch named (F2)
    sweep, sweepMtime, sweepContent, sweepsLeft, clean

vars == <<clock, disk, mtime, server, sentRec, lastSentSeq, staleSend, pc, content,
          readAt, startAt, enqAt, pending, running, record, recent, skipped,
          serverSaved, touchedSaved, sweep, sweepMtime, sweepContent, sweepsLeft, clean>>

Init ==
    /\ clock = 0
    /\ disk = "A" /\ mtime = 0
    /\ server = "A" /\ sentRec = "A" /\ lastSentSeq = 0 /\ staleSend = FALSE
    /\ pc = [p \in Procs |->
               CASE p = "w1" -> (IF Writes >= 1 THEN "write" ELSE "off")
                 [] p = "w2" -> (IF Writes = 2 THEN "write" ELSE "off")
                 [] p = "cas" -> (IF Cascade THEN "read" ELSE "off")
                 [] OTHER -> "off"]
    /\ content = [p \in Procs |-> "none"]
    /\ readAt = [p \in Procs |-> 0]
    /\ startAt = [p \in Procs |-> 0]
    /\ enqAt = [p \in Procs |-> 0]
    /\ pending = NoEntry
    /\ running = IF PriorInFlight
                    THEN [waiters |-> {}, content |-> "A", seq |-> 0, saved |-> FALSE,
                          sent |-> TRUE, recorded |-> FALSE]
                    ELSE NoEntry
    /\ record = [size |-> Size("A"), fp |-> Fp("A"), at |-> 0]
    /\ recent = [fp |-> Fp("A"), fresh |-> RecentA, savedHash |-> "none"]
    /\ skipped = "none" /\ serverSaved = "none" /\ touchedSaved = "none"
    /\ sweep = "idle" /\ sweepMtime = 0 /\ sweepContent = "none"
    /\ sweepsLeft = MidSweeps /\ clean = FALSE

Tick == clock' = clock + 1

\* The agent's write tool lands its bytes.
Write(p) ==
    /\ pc[p] = "write"
    /\ Tick /\ disk' = WriteOf[p] /\ mtime' = clock + 1
    /\ pc' = [pc EXCEPT ![p] = "read"]
    /\ UNCHANGED <<enqAt, server, sentRec, lastSentSeq, staleSend, content, readAt, startAt, pending,
                   running, record, recent, skipped, serverSaved, touchedSaved, sweep,
                   sweepMtime, sweepContent, sweepsLeft, clean>>

\* Pipeline readFileSync / cascade `await readFile`: capture disk.
Read(p) ==
    /\ pc[p] = "read" /\ p # "res"
    /\ Tick
    /\ content' = [content EXCEPT ![p] = disk]
    /\ readAt' = [readAt EXCEPT ![p] = clock + 1]
    /\ pc' = [pc EXCEPT ![p] = "start"]
    /\ UNCHANGED <<enqAt, disk, mtime, server, sentRec, lastSentSeq, staleSend, startAt, pending, running,
                   record, recent, skipped, serverSaved, touchedSaved, sweep, sweepMtime,
                   sweepContent, sweepsLeft, clean>>

\* touchFile begins: startedAt (the drift record's syncedAt) is taken here.
Start(p) ==
    /\ pc[p] = "start"
    /\ Tick
    /\ startAt' = [startAt EXCEPT ![p] = clock + 1]
    /\ pc' = [pc EXCEPT ![p] = "check"]
    /\ UNCHANGED <<enqAt, disk, mtime, server, sentRec, lastSentSeq, staleSend, content, readAt, pending,
                   running, record, recent, skipped, serverSaved, touchedSaved, sweep,
                   sweepMtime, sweepContent, sweepsLeft, clean>>

(***************************************************************************)
(* The gate's evidence, one branch per ContentGate value. "sent" is the    *)
(* code after #4532 gap 9 (lsp/index.ts shouldSkipNotify): the client's    *)
(* record of the payload it last sent for N, compared with this touch's    *)
(* content EXACTLY. It never consults the elapsed window, so a touch whose *)
(* own work outlived the window no longer re-pushes bytes the server       *)
(* already holds, and a record a didClose dropped no longer suppresses the *)
(* reopen. "window" is the pre-#4532 gate, which the code ran as a       *)
(* fallback until round 3 and runs nowhere now: a client that cannot       *)
(* report a record is PUSHED, because GateWindowReopen shows that gate can *)
(* leave a server holding no document at all for a file on disk. "lossy"   *)
(* is a mutant.                                                            *)
(***************************************************************************)
SkipEvidence(p) ==
    CASE ContentGate = "sent" ->
           sentRec # "none" /\ sentRec = content[p]
      [] ContentGate = "window" ->
           recent.fresh /\ recent.fp = Fp(content[p])
      [] ContentGate = "lossy" ->
           sentRec # "none" /\ Fp(sentRec) = Fp(content[p])

(***************************************************************************)
(* #4532 gap 9 round 3 F1. The record reports what LANDED; the path's      *)
(* notify queue holds what is still to come. A skip decides on the record, *)
(* so it may only be taken when nothing is left to send: ClipQueueIdle.    *)
(* SkipNeedsIdle = FALSE is the code before this round, where a send in    *)
(* flight landed after the skip and installed the touch's older read.      *)
(* F2 rides the same action: a skip sends no content, so it owes the save  *)
(* its own content identity requires, and marks the entry for THOSE bytes. *)
(***************************************************************************)
QueueIdle == pending = NoEntry /\ running = NoEntry

SkipNow(p) ==
    /\ Debounce /\ p # "res"
    /\ (SkipNeedsIdle => QueueIdle)
    /\ SkipEvidence(p)

\* saveDebouncedPush's premise: a saved touch of bytes the server holds whose
\* save did NOT go out for exactly those bytes. SaveBoundToContent = FALSE is
\* the code before this round: any recorded save suppressed the next one.
OwesSave(p) ==
    /\ SavedTouches
    /\ IF SaveBoundToContent THEN recent.savedHash # content[p]
                             ELSE recent.savedHash = "none"

\* shouldSkipTouch / notifySkippedServerIds: a skip sends and records nothing.
\* The drift resync uses scope "all", a different debounce key: never skipped here.
Check(p) ==
    /\ pc[p] = "check"
    /\ pc' = [pc EXCEPT ![p] = IF SkipNow(p) THEN "done" ELSE "enqueue"]
    /\ skipped' = IF SkipNow(p) THEN content[p] ELSE "none"
    /\ touchedSaved' = IF SavedTouches /\ p # "res"
                          THEN content[p]
                          ELSE touchedSaved
    /\ IF SkipNow(p) /\ OwesSave(p)
         THEN /\ serverSaved' = content[p]
              /\ recent' = [recent EXCEPT !.savedHash = content[p]]
         ELSE UNCHANGED <<serverSaved, recent>>
    /\ UNCHANGED <<enqAt, clock, disk, mtime, server, sentRec, lastSentSeq, staleSend, content, readAt,
                   startAt, pending, running, record, sweep, sweepMtime,
                   sweepContent, sweepsLeft, clean>>

\* notify.open -> enqueueDocumentNotify: last enqueued wins, waiters carried.
\* The first entry of an idle queue starts on the next microtask, before any
\* other actor's I/O continuation can enqueue: modelled as RunStart having to
\* fire first (no Enqueue while an entry is pending on an idle runner).
Enqueue(p) ==
    /\ pc[p] = "enqueue"
    /\ ~(pending # NoEntry /\ running = NoEntry)
    /\ Tick
    /\ enqAt' = [enqAt EXCEPT ![p] = clock + 1]
    /\ LET keepOld == FixCoalesce /\ pending # NoEntry /\ pending.seq > readAt[p]
       IN pending' = [waiters |-> pending.waiters \cup {p},
                      content |-> IF keepOld THEN pending.content ELSE content[p],
                      seq     |-> IF keepOld THEN pending.seq ELSE readAt[p],
                      saved   |-> SavedTouches,
                      sent    |-> FALSE,
                      recorded |-> FALSE]
    /\ pc' = [pc EXCEPT ![p] = "wait"]
    /\ skipped' = "none"
    /\ UNCHANGED <<disk, mtime, server, sentRec, lastSentSeq, staleSend, content, readAt,
                   startAt, running, record, recent, serverSaved, touchedSaved,
                   sweep, sweepMtime, sweepContent, sweepsLeft, clean>>

\* Take the unstarted entry and send it: check and send are one tick.
\* `sent` is false for an entry the runner drops (#3481): nothing goes on the
\* wire, so nothing is recorded. A saved push carries its didSave, so the
\* server's save follows the content it wrote (#3405).
TakeAndSend ==
    /\ LET dropped == FixDrop /\ pending.seq < lastSentSeq
       IN /\ running' = [pending EXCEPT !.sent = ~dropped, !.recorded = dropped]
          /\ pending' = NoEntry
          /\ IF dropped
               THEN UNCHANGED <<server, lastSentSeq, staleSend, serverSaved>>
               ELSE /\ server' = pending.content
                    /\ lastSentSeq' = pending.seq
                    /\ staleSend' = (staleSend \/ (pending.seq < lastSentSeq /\ pending.content # server))
                    /\ serverSaved' = IF pending.saved THEN pending.content ELSE serverSaved

\* The runner's first iteration (microtask after the first enqueue).
RunStart ==
    /\ running = NoEntry /\ pending # NoEntry
    /\ TakeAndSend
    /\ UNCHANGED <<clock, disk, mtime, pc, content, readAt, startAt, enqAt, record, recent,
                   sentRec, skipped, touchedSaved, sweep, sweepMtime, sweepContent,
                   sweepsLeft, clean>>

\* The in-flight send resolves: its waiters are resolved, and the runner's
\* for(;;) loop takes the next unstarted entry in the same tick (client.ts).
\* `running.recorded` is the code's order: recordSentContent runs inside the
\* send's own continuation, so the queue is never idle with the record behind
\* it (RunFinish would otherwise clear `running` before Record fired).
RunFinish ==
    /\ running # NoEntry /\ running.recorded
    /\ pc' = [p \in Procs |-> IF p \in running.waiters THEN "landed" ELSE pc[p]]
    /\ IF pending # NoEntry
         THEN TakeAndSend
         ELSE /\ running' = NoEntry
              /\ UNCHANGED <<pending, server, sentRec, lastSentSeq, staleSend, serverSaved>>
    /\ UNCHANGED <<clock, disk, mtime, content, readAt, startAt, enqAt, record, recent,
                   sentRec, skipped, touchedSaved, sweep, sweepMtime, sweepContent,
                   sweepsLeft, clean>>

\* recordSentContent runs in the SEND's own continuation (client.ts
\* enqueueDocumentNotify: `await next.run(...)`, and the run records after its
\* wire write lands, before its waiters resolve), so the record lags the wire
\* write by one await. The gate reads that record, never the wire, so the
\* schedules below are checked with the lag present.
Record ==
    /\ running # NoEntry /\ running.sent /\ ~running.recorded
    /\ sentRec' = running.content
    /\ running' = [running EXCEPT !.recorded = TRUE]
    /\ UNCHANGED <<clock, disk, mtime, server, lastSentSeq, staleSend, pc, content,
                   readAt, startAt, enqAt, pending, record, recent, skipped,
                   serverSaved, touchedSaved, sweep, sweepMtime, sweepContent,
                   sweepsLeft, clean>>

(***************************************************************************)
(* #3477: a didClose for N. In the code it is a queue entry, so this action *)
(* stands only for the order that queue guarantees: nothing pending and    *)
(* nothing in flight. It drops the client's content record and the         *)
(* server's document. `recent` and the drift record survive it, so the     *)
(* pre-fix window gate can still skip the reopen and leave the server      *)
(* holding nothing at all for a file on disk. Modelled only while another  *)
(* actor can still touch N (MidClose), so every close is followed by the   *)
(* attempt the fix is about; a close no touch ever follows is not a defect *)
(* of the gate.                                                            *)
(***************************************************************************)
CloseDoc ==
    /\ MidClose
    /\ pending = NoEntry /\ running = NoEntry /\ server # "none"
    /\ \E p \in {"w1", "w2", "cas"} : pc[p] \in {"read", "start", "check"}
    /\ server' = "none" /\ sentRec' = "none"
    /\ skipped' = "none"
    /\ UNCHANGED <<clock, disk, mtime, lastSentSeq, staleSend, pc, content, readAt,
                   startAt, enqAt, pending, running, record, recent, serverSaved,
                   touchedSaved, sweep, sweepMtime, sweepContent, sweepsLeft, clean>>

\* touchFile after its write landed: markTouched (primary scope) and the drift
\* record stamped with its OWN content at its START time.
Finish(p) ==
    /\ pc[p] = "landed"
    /\ FifoLanding => \A q \in Procs : pc[q] = "landed" => enqAt[q] >= enqAt[p]
    /\ record' = [size |-> Size(content[p]), fp |-> Fp(content[p]), at |-> startAt[p]]
    /\ recent' = IF p = "res"
         THEN recent
         ELSE [fp |-> Fp(content[p]), fresh |-> TRUE,
               savedHash |-> IF SavedTouches THEN content[p] ELSE "none"]
    /\ pc' = [pc EXCEPT ![p] = "done"]
    /\ UNCHANGED <<enqAt, clock, disk, mtime, server, sentRec, lastSentSeq, staleSend, content, readAt,
                   startAt, pending, running, skipped, serverSaved, touchedSaved, sweep,
                   sweepMtime, sweepContent, sweepsLeft, clean>>

\* #4532 gap 9 F2: a content push that is NOT a touch — `LSPService.openFile`,
\* which `resyncDocumentOnPastEof` uses. It advances the client's record and
\* the server and stamps the drift record, and it marks no touch, so `recent`
\* (and with it `savedHash`) keeps naming the older bytes. It goes through the
\* queue too, so it stands only for the order that guarantees: nothing queued.
OpenFilePush ==
    /\ OpenFilePushes
    /\ pending = NoEntry /\ running = NoEntry
    \* Two scenario bounds, both content/mark based:
    \*  - the caller resyncs a document whose bytes the record no longer
    \*    describes (`resyncDocumentOnPastEof`), and the push itself catches the
    \*    record up, so it cannot fire twice for one disk state;
    \*  - only a save mark that is already stale makes this writer interesting
    \*    here, which is the whole reason F2 exists. Schedules with no mark
    \*    exercise nothing the gate decides.
    /\ Fp(disk) # record.fp
    /\ recent.savedHash # "none"
    /\ \E p \in {"w1", "w2", "cas"} : pc[p] \in {"read", "start", "check"}
    /\ Tick
    /\ server' = disk /\ sentRec' = disk
    /\ record' = [size |-> Size(disk), fp |-> Fp(disk), at |-> clock + 1]
    /\ skipped' = "none"
    /\ UNCHANGED <<disk, mtime, lastSentSeq, staleSend, pc, content, readAt, startAt, enqAt,
                   pending, running, recent, serverSaved, touchedSaved, sweep,
                   sweepMtime, sweepContent, sweepsLeft, clean>>

\* TOUCH_DEBOUNCE_MS elapses.
Expire ==
    /\ recent.fresh
    /\ recent' = [recent EXCEPT !.fresh = FALSE]
    /\ UNCHANGED <<enqAt, clock, disk, mtime, server, sentRec, lastSentSeq, staleSend, pc, content, readAt,
                   startAt, pending, running, record, skipped, serverSaved, touchedSaved,
                   sweep, sweepMtime, sweepContent, sweepsLeft, clean>>

OthersDone ==
    /\ \A p \in {"w1", "w2", "cas"} : pc[p] \in {"off", "done"}
    /\ pending = NoEntry /\ running = NoEntry

\* A sweep pass: stat and compare against the record.
SweepStat ==
    /\ sweep = "idle"
    /\ pc["res"] \in {"off", "done"}
    /\ sweepsLeft > 0 \/ OthersDone
    /\ ~(OthersDone /\ clean)
    /\ LET sizeMoved == SweepKey # "mtime" /\ Size(disk) # record.size
           mtimeMoved == SweepKey # "size" /\ mtime > record.at
       IN IF sizeMoved \/ mtimeMoved
            THEN /\ sweep' = "read" /\ sweepMtime' = mtime /\ clean' = FALSE
            ELSE /\ clean' = OthersDone /\ UNCHANGED <<sweep, sweepMtime>>
    /\ sweepsLeft' = IF OthersDone THEN sweepsLeft ELSE sweepsLeft - 1
    /\ UNCHANGED <<enqAt, clock, disk, mtime, server, sentRec, lastSentSeq, staleSend, pc, content, readAt,
                   startAt, pending, running, record, recent, skipped, serverSaved,
                   touchedSaved, sweepContent>>

\* The candidate is read; unchanged fingerprint re-stamps, otherwise resync.
SweepRead ==
    /\ sweep = "read"
    /\ Tick
    /\ IF Fp(disk) = record.fp
         THEN /\ record' = [size |-> Size(disk), fp |-> Fp(disk), at |-> Max(clock + 1, sweepMtime)]
              /\ sweep' = "idle"
              /\ UNCHANGED <<pc, content, readAt, sweepContent>>
         ELSE /\ sweep' = "resync"
              /\ sweepContent' = disk
              /\ content' = [content EXCEPT !["res"] = disk]
              /\ readAt' = [readAt EXCEPT !["res"] = clock + 1]
              /\ pc' = [pc EXCEPT !["res"] = "start"]
              /\ UNCHANGED record
    /\ UNCHANGED <<enqAt, disk, mtime, server, sentRec, lastSentSeq, staleSend, startAt, pending, running,
                   recent, skipped, serverSaved, touchedSaved, sweepMtime, sweepsLeft, clean>>

\* After the resync touch: stamp authoritatively if the record advanced to it.
SweepSettle ==
    /\ sweep = "resync" /\ pc["res"] = "done"
    /\ Tick
    /\ record' = IF record.fp = Fp(sweepContent)
                   THEN [size |-> Size(sweepContent), fp |-> Fp(sweepContent),
                         at |-> Max(clock + 1, sweepMtime)]
                   ELSE record
    /\ sweep' = "idle"
    /\ UNCHANGED <<enqAt, disk, mtime, server, sentRec, lastSentSeq, staleSend, pc, content, readAt,
                   startAt, pending, running, recent, skipped, serverSaved, touchedSaved,
                   sweepMtime, sweepContent, sweepsLeft, clean>>

Next ==
    \/ \E p \in Writers : Write(p)
    \/ \E p \in Procs : Read(p) \/ Start(p) \/ Check(p) \/ Enqueue(p) \/ Finish(p)
    \/ RunStart \/ RunFinish \/ Expire \/ Record \/ CloseDoc \/ OpenFilePush
    \/ SweepStat \/ SweepRead \/ SweepSettle

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

\* Every actor is done, the queue is empty, and a full sweep pass after that
\* found nothing to do.
Quiescent == OthersDone /\ sweep = "idle" /\ pc["res"] \in {"off", "done"} /\ clean

\* Once quiescent, the server holds exactly what is on disk. Under MidClose
\* this also covers a document the server no longer has at all: a close that
\* the gate never reopens leaves server = "none" against a file on disk.
ServerMatchesDisk == Quiescent => server = disk

\* Per-send: the runner never replaces content with DIFFERENT content read earlier.
SendsMonotone == ~staleSend

\* #4532 gap 9 round 3 F1: a skip certifies that the server holds the bytes the
\* touch read, and a send ALREADY in flight may not then replace them. While
\* those bytes are what disk holds, that certificate is the difference between
\* a server on disk and a server on older bytes — the lost update the queue
\* accessor (`hasNotifyInFlight`) keeps out of the gate. A skip of bytes disk
\* has already moved past owes nothing, and a decision taken AFTER the skip
\* (an enqueue, an `openFile` push, a didClose) supersedes the certificate.
SkippedContentHeld ==
    skipped = "none" \/ disk # skipped \/ server = skipped

\* #4532 gap 9 round 3 F2: "the touch debounce never drops a save". Once every
\* actor is done, the bytes the most recent SAVED touch named, when the server
\* still holds them, carry a didSave (`savedHash` bound to its own content).
\* The drift resync's own saved flag is out of scope: its content is disk, not
\* a caller's touch (`p # "res"`).
SaveFollowsSavedTouch ==
    Quiescent =>
        (touchedSaved = "none" \/ server # touchedSaved \/ serverSaved = touchedSaved)
=============================================================================
