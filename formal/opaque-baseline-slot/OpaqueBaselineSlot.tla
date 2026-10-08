------------------------ MODULE OpaqueBaselineSlot ------------------------
(***************************************************************************)
(* The pending opaque baseline of parallel bash calls                      *)
(* (clients/opaque-mutation-scan.ts OpaqueBaselineStore, recorded at       *)
(* tool_call in clients/runtime-tool-call.ts, taken at tool_result in      *)
(* clients/runtime-tool-result.ts; #4137).                                 *)
(*                                                                         *)
(* pi runs the bash calls of one assistant message in parallel, so every   *)
(* tool_call precedes the first tool_result. Each call (a writer) records  *)
(* a baseline, writes the one path its own text names, and takes a         *)
(* baseline at its tool_result. A call authored its write only if it took  *)
(* a baseline and its authored dispatch reached the pipeline.              *)
(*                                                                         *)
(* Actions:                                                                *)
(*  - Record(w): tool_call stores w's baseline under its key. A baseline   *)
(*    already under that key is overwritten and its owner's baseline is    *)
(*    lost;                                                                *)
(*  - Evict(w): Record on a full store drops the oldest baseline (the      *)
(*    OPAQUE_BASELINE_PENDING_CAP bound) and its owner's baseline is lost; *)
(*  - Write(w): the command writes its path, between Record and Take;      *)
(*  - Take(w): tool_result removes the baseline under w's key and plans   *)
(*    the recovery: a call that holds one claims the changed paths other   *)
(*    than its own as opaque; a call with none plans nothing               *)
(*    (partial-recognition-no-baseline);                                   *)
(*  - Dispatch(w): after the awaits between the take and the synthetic     *)
(*    writes, w's own path is dispatched with authorship if it holds a     *)
(*    baseline, then its opaque paths without autonomous rights. A call    *)
(*    with none dispatches its own path without authorship.                *)
(*                                                                         *)
(* Keying "cwd" is the pre-fix store: one key per cwd:generation. Keying   *)
(* "call" is the fix: one key per tool-call id.                            *)
(*                                                                         *)
(* A dispatch of a path already analysed is skipped (the pipeline's        *)
(* content dedupe), so an opaque claim of a sibling's path dispatched      *)
(* before the sibling's authored dispatch burns it, even when the sibling  *)
(* already took its baseline and its dispatch is still in flight. Subtract *)
(* is the fix's second half: a taken baseline's recovery leaves out the    *)
(* recognized paths of every call whose lifetime overlapped it (the        *)
(* still-pending entries and the calls that took after this one            *)
(* recorded).                                                              *)
(*                                                                         *)
(* A call's recovery window holds the writes that landed after it          *)
(* recorded (git status filtered by mtime from the baseline's startedAt).  *)
(* Conservative on purpose: a taker that finds a baseline recorded by      *)
(* another call counts as holding one (its window is the other call's,     *)
(* which the model does not track).                                        *)
(*                                                                         *)
(* Invariants:                                                             *)
(*  - EveryWriteAttributed: a finished call authored its own write;        *)
(*  - SlotLossObservable: a displaced baseline is counted once in the      *)
(*    degradation ledger, and a call that finds nothing never goes         *)
(*    unrecorded.                                                          *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Writers,     \* the parallel bash calls A, B, C
    Keying,      \* "cwd" (pre-fix) | "call" (per tool-call id)
    Cap,         \* baselines the store holds before dropping the oldest
    Subtract,    \* TRUE: recovery leaves out overlapping siblings' paths
    Observe,     \* "counted" (the fix) | "none" (pre-fix evictionCount)
    Sequential   \* TRUE: a call records only when no other is in flight

VARIABLES
    pc,        \* [Writers -> "new" | "called" | "taken" | "done"]
    written,   \* paths whose command has run (path w is writer w's)
    window,    \* [Writers -> paths written since w recorded]
    slot,      \* sequence of [key, owner], oldest first
    lost,      \* owners whose baseline was displaced
    ledger,    \* the degradation ledger's count of displaced baselines
    missed,    \* calls that took no baseline
    seen,      \* [Writers -> calls that took a baseline after w recorded]
    analysed,  \* paths a dispatch has already analysed
    authored,  \* calls whose own path got the authorship dispatch
    plan       \* [Writers -> the opaque paths w planned at its take]

vars == <<pc, written, window, slot, lost, ledger, missed, seen, analysed, authored,
          plan>>

TypeOK ==
    /\ pc \in [Writers -> {"new", "called", "taken", "done"}]
    /\ written \subseteq Writers
    /\ window \in [Writers -> SUBSET Writers]
    /\ lost \subseteq Writers
    /\ ledger \in Nat
    /\ missed \subseteq Writers
    /\ seen \in [Writers -> SUBSET Writers]
    /\ analysed \subseteq Writers
    /\ authored \subseteq Writers
    /\ plan \in [Writers -> SUBSET Writers]
    /\ Len(slot) <= Cap

Key(w) == IF Keying = "cwd" THEN 0 ELSE w

HasKey(k) == \E i \in 1..Len(slot) : slot[i].key = k
IndexOf(k) == CHOOSE i \in 1..Len(slot) : slot[i].key = k

DeleteAt(s, i) ==
    [j \in 1..(Len(s) - 1) |-> IF j < i THEN s[j] ELSE s[j + 1]]

Counted == IF Observe = "counted" THEN 1 ELSE 0

Init ==
    /\ pc = [w \in Writers |-> "new"]
    /\ written = {}
    /\ window = [w \in Writers |-> {}]
    /\ slot = <<>>
    /\ lost = {}
    /\ ledger = 0
    /\ missed = {}
    /\ seen = [w \in Writers |-> {}]
    /\ analysed = {}
    /\ authored = {}
    /\ plan = [w \in Writers |-> {}]

CanRecord(w) ==
    /\ pc[w] = "new"
    /\ (Sequential => \A o \in Writers : pc[o] \notin {"called", "taken"})

\* tool_call: store the baseline under w's key; a baseline under that key is
\* overwritten and its owner's baseline is lost.
Record(w) ==
    /\ CanRecord(w)
    /\ \/ /\ HasKey(Key(w))
          /\ LET i == IndexOf(Key(w))
             IN /\ slot' = Append(DeleteAt(slot, i), [key |-> Key(w), owner |-> w])
                /\ lost' = lost \cup {slot[i].owner}
                /\ ledger' = ledger + Counted
       \/ /\ ~HasKey(Key(w))
          /\ Len(slot) < Cap
          /\ slot' = Append(slot, [key |-> Key(w), owner |-> w])
          /\ UNCHANGED <<lost, ledger>>
    /\ pc' = [pc EXCEPT ![w] = "called"]
    /\ UNCHANGED <<written, window, missed, seen, analysed, authored, plan>>

\* tool_call on a full store: the oldest baseline is dropped and counted.
Evict(w) ==
    /\ CanRecord(w)
    /\ ~HasKey(Key(w))
    /\ Len(slot) = Cap
    /\ slot' = Append(Tail(slot), [key |-> Key(w), owner |-> w])
    /\ lost' = lost \cup {Head(slot).owner}
    /\ ledger' = ledger + Counted
    /\ pc' = [pc EXCEPT ![w] = "called"]
    /\ UNCHANGED <<written, window, missed, seen, analysed, authored, plan>>

\* The bash command runs and writes the path its own text names.
Write(w) ==
    /\ pc[w] = "called"
    /\ w \notin written
    /\ written' = written \cup {w}
    /\ window' = [b \in Writers |->
                    IF pc[b] # "new" THEN window[b] \cup {w} ELSE window[b]]
    /\ UNCHANGED <<pc, slot, lost, ledger, missed, seen, analysed, authored, plan>>

\* tool_result: take the baseline under w's key and plan the recovery.
Take(w) ==
    /\ pc[w] = "called"
    /\ w \in written
    /\ pc' = [pc EXCEPT ![w] = "taken"]
    /\ IF HasKey(Key(w))
       THEN LET i == IndexOf(Key(w))
                rest == DeleteAt(slot, i)
                siblings == seen[w] \cup {rest[j].owner : j \in 1..Len(rest)}
            IN /\ slot' = rest
               /\ plan' = [plan EXCEPT ![w] =
                              (window[w] \ {w}) \ (IF Subtract THEN siblings ELSE {})]
               /\ seen' = [o \in Writers |->
                              IF o # w /\ pc[o] # "new" THEN seen[o] \cup {w} ELSE seen[o]]
               /\ UNCHANGED missed
       ELSE /\ missed' = missed \cup {w}
            /\ UNCHANGED <<slot, plan, seen>>
    /\ UNCHANGED <<written, window, lost, ledger, analysed, authored>>

\* The synthetic writes: the recognized path first, then the opaque ones; a
\* path already analysed is skipped.
Dispatch(w) ==
    /\ pc[w] = "taken"
    /\ pc' = [pc EXCEPT ![w] = "done"]
    /\ IF w \in missed
       THEN /\ analysed' = analysed \cup {w}
            /\ UNCHANGED authored
       ELSE /\ authored' = IF w \in analysed THEN authored ELSE authored \cup {w}
            /\ analysed' = analysed \cup {w} \cup plan[w]
    /\ UNCHANGED <<written, window, slot, lost, ledger, missed, seen, plan>>

Next ==
    \E w \in Writers :
        Record(w) \/ Evict(w) \/ Write(w) \/ Take(w) \/ Dispatch(w)

Spec == Init /\ [][Next]_vars

(* A finished call authored its own write. *)
EveryWriteAttributed ==
    \A w \in Writers : pc[w] = "done" => w \in authored

(* A displaced baseline is counted once, and a miss is never unrecorded. *)
SlotLossObservable ==
    /\ ledger = Cardinality(lost)
    /\ missed # {} => ledger > 0
=============================================================================
