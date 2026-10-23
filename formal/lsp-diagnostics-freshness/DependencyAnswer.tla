------------------------- MODULE DependencyAnswer -------------------------
(***************************************************************************)
(* #4782: which push answer for a dependent a.ts the dispatch read takes  *)
(* after one bash command rewrote a.ts and its dependency z.ts.            *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - the primary phase (resyncHeldPrimaries, clients/lsp/index.ts): it    *)
(*    sends a.ts's didChange (handleNotifyOpenOnce clears a.ts's cache and *)
(*    pending receipt in that tick, so the model starts with both empty),  *)
(*    then z.ts's, then the drain request, in order on one stream. The     *)
(*    dispatch's wait starts only after the drain reply (a drained phase); *)
(*  - the server: reads its input in order; once it has read a.ts's change  *)
(*    it may publish a.ts's check, computed against the z.ts it holds      *)
(*    (ghost `zv`); the answer before z.ts's change STOPs (non-empty), the *)
(*    one after it is clean. Republish: having read z.ts's change, it      *)
(*    publishes a.ts's re-check before it reads its next message (the fake *)
(*    checker's synchronous republish). Server-to-client messages are FIFO;*)
(*  - the publishDiagnostics handler (client.ts, setupIncomingHandlers):   *)
(*    a version-less receipt replaces the pending one in the quiet-window  *)
(*    slot (`pendingDiagnostics`); the slot's timer stores it and emits;   *)
(*  - the waiter, the skipped dispatch touch (no baseline):                *)
(*    clientWaitForDiagnostics's early return (a non-empty cache), else a  *)
(*    listener whose quiet window settles on the cache; a timeout also     *)
(*    resolves it; touchFile then reads the cache.                         *)
(*                                                                         *)
(* PendingGuard (the fix): neither the early return nor the quiet-window   *)
(* settle takes the cache while the slot holds a later receipt; the        *)
(* slot's store re-arms the window. Each receipt carries a ghost `seq`, its*)
(* receive order.                                                          *)
(*                                                                         *)
(* Not modelled: a publish computed before the server read a.ts's own      *)
(* change (that is DiagnosticsFreshness's #3484 shape: the server here     *)
(* publishes only after reading it); versioned publishes and the three     *)
(* unstored exits of the slot (superseded, config-failure refusal, a clear *)
(* that cancels it); a clear, which also empties the cache, so the wait    *)
(* settles only on a later store (#4785 F4); seed-first-push strategies,   *)
(* whose store cancels the slot (#4785 F1), so a receipt in the slot is    *)
(* always the later one; all pinned by the #4782/#4785 tests under         *)
(* tests/clients/lsp/; threaded or undrained phases (`undrained`).         *)
(***************************************************************************)
EXTENDS Integers, Sequences

CONSTANTS
    PendingGuard, \* the fix (#4782): a pending later receipt outranks the cache
    Republish,    \* the server republishes a.ts as it reads z.ts's change
    MaxPubs,      \* bound on server publishes
    Mutant        \* "none" | "noSettleGuard" (the guard on the early return only)

NONE == -1

VARIABLES
    wire,     \* client -> server messages not yet read
    srvA,     \* the server has read a.ts's change
    srvZ,     \* the z.ts version the server holds (0 old, 1 new)
    owed,     \* Republish: a.ts's re-check is owed before the next read
    pubs,     \* server -> client messages not yet handled (FIFO)
    npubs,
    rx,       \* receipts handled so far (the next receipt's seq)
    cache,    \* pushDiagnostics: [has, zv, ne, seq]
    slot,     \* pendingDiagnostics: [on, zv, ne, seq]
    drained,  \* the drain reply arrived
    w,        \* "idle" | "listen" | "armed" | "deferred" | "resolved" | "read"
    how,      \* "none" | "settled" | "timeout"
    newest,   \* ghost: at the settle, the cache held the newest receipt
    result    \* the cache touchFile read

vars == <<wire, srvA, srvZ, owed, pubs, npubs, rx, cache, slot, drained, w,
          how, newest, result>>

Empty == [has |-> FALSE, zv |-> NONE, ne |-> FALSE, seq |-> NONE]
Off == [on |-> FALSE, zv |-> NONE, ne |-> FALSE, seq |-> NONE]

Init ==
    /\ wire = << "a", "z", "drain" >>
    /\ srvA = FALSE
    /\ srvZ = 0
    /\ owed = FALSE
    /\ pubs = << >>
    /\ npubs = 0
    /\ rx = 0
    /\ cache = Empty
    /\ slot = Off
    /\ drained = FALSE
    /\ w = "idle"
    /\ how = "none"
    /\ newest = TRUE
    /\ result = Empty

\* The guard at each site. The early return keeps it under every mutant.
StartGuarded == PendingGuard
SettleGuarded == PendingGuard /\ Mutant # "noSettleGuard"

-----------------------------------------------------------------------------
\* The server.

ServerRead ==
    /\ wire # << >>
    /\ ~owed
    /\ LET m == Head(wire) IN
         /\ srvA' = (srvA \/ m = "a")
         /\ srvZ' = IF m = "z" THEN 1 ELSE srvZ
         /\ owed' = (Republish /\ m = "z")
         /\ pubs' = IF m = "drain"
                      THEN Append(pubs, [k |-> "reply", zv |-> NONE, ne |-> FALSE])
                      ELSE pubs
    /\ wire' = Tail(wire)
    /\ UNCHANGED <<npubs, rx, cache, slot, drained, w, how, newest, result>>

ServerPublish ==
    /\ srvA
    /\ npubs < MaxPubs
    /\ pubs' = Append(pubs, [k |-> "pub", zv |-> srvZ, ne |-> (srvZ = 0)])
    /\ npubs' = npubs + 1
    /\ owed' = FALSE
    /\ UNCHANGED <<wire, srvA, srvZ, rx, cache, slot, drained, w, how, newest,
                   result>>

-----------------------------------------------------------------------------
\* The publishDiagnostics handler and its quiet-window slot (client.ts).

ClientReceive ==
    /\ pubs # << >>
    /\ pubs' = Tail(pubs)
    /\ LET p == Head(pubs) IN
       IF p.k = "reply"
         THEN /\ drained' = TRUE
              /\ UNCHANGED <<rx, slot>>
         ELSE /\ slot' = [on |-> TRUE, zv |-> p.zv, ne |-> p.ne, seq |-> rx]
              /\ rx' = rx + 1
              /\ UNCHANGED drained
    /\ UNCHANGED <<wire, srvA, srvZ, owed, npubs, cache, w, how, newest, result>>

\* The slot's timer stores the receipt and emits; a listening, armed or
\* deferred waiter (re)arms its quiet window.
SlotFire ==
    /\ slot.on
    /\ cache' = [has |-> TRUE, zv |-> slot.zv, ne |-> slot.ne, seq |-> slot.seq]
    /\ slot' = Off
    /\ w' = IF w \in {"listen", "armed", "deferred"} THEN "armed" ELSE w
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, drained, how,
                   newest, result>>

-----------------------------------------------------------------------------
\* The waiter: the skipped dispatch touch, after the drain reply.

WaitStart ==
    /\ w = "idle"
    /\ drained
    /\ IF cache.has /\ cache.ne /\ ~(StartGuarded /\ slot.on)
         THEN /\ w' = "resolved"
              /\ how' = "settled"
              /\ newest' = ~slot.on
         ELSE /\ w' = "listen"
              /\ UNCHANGED <<how, newest>>
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, cache, slot,
                   drained, result>>

WaitSettle ==
    /\ w = "armed"
    /\ IF SettleGuarded /\ slot.on
         THEN /\ w' = "deferred"
              /\ UNCHANGED <<how, newest>>
         ELSE /\ w' = "resolved"
              /\ how' = "settled"
              /\ newest' = ~slot.on
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, cache, slot,
                   drained, result>>

WaitTimeout ==
    /\ w \in {"listen", "armed", "deferred"}
    /\ w' = "resolved"
    /\ how' = "timeout"
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, cache, slot,
                   drained, newest, result>>

Read ==
    /\ w = "resolved"
    /\ w' = "read"
    /\ result' = cache
    /\ UNCHANGED <<wire, srvA, srvZ, owed, pubs, npubs, rx, cache, slot,
                   drained, how, newest>>

Next == ServerRead \/ ServerPublish \/ ClientReceive \/ SlotFire
        \/ WaitStart \/ WaitSettle \/ WaitTimeout \/ Read

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

\* The rule: a wait settles only on the newest receipt it holds; no later
\* receipt sits in the quiet-window slot at that moment.
NewestAtSettle == how = "settled" => newest

\* Its consequence for the bash write: a settled read of a.ts was computed
\* against z.ts's new bytes (#4782's phantom STOP is a read with zv = 0).
NoPhantomFinding == (w = "read" /\ how = "settled" /\ result.has) => result.zv = 1
=============================================================================
