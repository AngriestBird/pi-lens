--------------------------- MODULE BashWriteOrder ---------------------------
(***************************************************************************)
(* The order in which one bash command's writes reach the primary server   *)
(* (#4507). The command rewrites two held documents: a dependency z and a  *)
(* dependent a whose new bytes import a name the command adds to z. Its    *)
(* tool_result then dispatches each written file, one at a time, in the    *)
(* order git status or the command recognizer lists them (either order).  *)
(* A dispatch sends its file's disk bytes to the primary and reads the     *)
(* primary's check of that file, which reads the primary's view of every   *)
(* held document (a dependent is checked against the dependency the        *)
(* server holds).                                                          *)
(*                                                                         *)
(* WritesPrimaryFirst TRUE (the fix, sendToHeldPrimaries in                *)
(* clients/runtime-tool-result.ts): before the dispatch loop, every        *)
(* written held document whose sent bytes differ from the disk goes to the *)
(* primary, awaited. FALSE (before #4507): a file reached the primary only *)
(* in its own dispatch, and an opaque command's paths were resent detached *)
(* after the loop.                                                         *)
(*                                                                         *)
(* Model assumption, as in HeadMoveHookBound: the primary sends fit in the *)
(* hook bound (primaries are not paced); a phase the bound cuts is         *)
(* disclosed by the bash_write_primary_resync row ("cut") and is not       *)
(* modelled.                                                               *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    WritesPrimaryFirst  \* TRUE: written held documents reach the primary first

Docs == {"a", "z"}

VARIABLES
    disk,     \* per document: the version on disk
    P,        \* per document: the version the primary holds
    order,    \* the dispatch order, chosen when the command runs
    pc,       \* "run", "primary", "dispatch", "done"
    i,        \* the next dispatch
    phantom   \* a check read a held document's old bytes

vars == <<disk, P, order, pc, i, phantom>>

Init ==
    /\ disk = [d \in Docs |-> 0]
    /\ P = [d \in Docs |-> 0]
    /\ order = <<>>
    /\ pc = "run"
    /\ i = 1
    /\ phantom = FALSE

(* The command rewrites both files; the result lists them in either order. *)
Run ==
    /\ pc = "run"
    /\ disk' = [d \in Docs |-> 1]
    /\ \E o \in {<<"a", "z">>, <<"z", "a">>} : order' = o
    /\ pc' = IF WritesPrimaryFirst THEN "primary" ELSE "dispatch"
    /\ UNCHANGED <<P, i, phantom>>

(* The awaited primary phase: each held document whose bytes differ. *)
Primary ==
    /\ pc = "primary"
    /\ P' = disk
    /\ pc' = "dispatch"
    /\ UNCHANGED <<disk, order, i, phantom>>

(* One dispatch: send the file, then read the check, which reads every view. *)
Dispatch ==
    /\ pc = "dispatch"
    /\ LET f == order[i]
           sent == [P EXCEPT ![f] = disk[f]]
       IN /\ P' = sent
          /\ phantom' = (phantom \/ \E d \in Docs : sent[d] # disk[d])
    /\ i' = i + 1
    /\ pc' = IF i = Len(order) THEN "done" ELSE "dispatch"
    /\ UNCHANGED <<disk, order>>

Next == Run \/ Primary \/ Dispatch

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ pc \in {"run", "primary", "dispatch", "done"}
    /\ i \in 1..3

(* No dispatch checks a file against a held document's old bytes. *)
NoPhantomFinding == ~phantom

(* Once the result is done, the primary holds the disk bytes. *)
SettledFresh == pc = "done" => \A d \in Docs : P[d] = disk[d]
=============================================================================
