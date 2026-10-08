--------------------------- MODULE LspEphemeralDataDir ---------------------------
(***************************************************************************)
(* The per-process data directory used by temporary LSP checkouts (#1129, *)
(* #4127).  A process settles one classification for a root, then selects  *)
(* one token beneath the root's .ephemeral directory.  The token is shared *)
(* by all roots in that process, but is distinct from every other process.  *)
(* A session-start sweep may remove an old token only when its pid is not   *)
(* currently alive.  Pid reuse therefore leaves the old token alone.        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    ProcIds,       \* bounded process identities (not pid slots)
    Pids,          \* reusable OS pid slots
    Roots,         \* temporary checkout roots
    MaxStarts,     \* bound on process starts
    UniqueToken,   \* TRUE: process token; FALSE: pre-#4127 pid-only token
    SafeSweep      \* TRUE: sweep checks current pid liveness

Classifications == {"unknown", "ephemeral", "normal"}

VARIABLES
    live,          \* currently live process identities
    pidOf,         \* process identity -> current pid
    tokenOf,       \* process identity -> settled data-dir token
    rootOf,        \* process identity -> classified root
    memo,          \* root -> classification, settled once per process model
    dirs,          \* records left below .ephemeral
    removed,       \* records removed by a sweep, for SweepOnlyDead
    starts         \* number of process starts

vars == <<live, pidOf, tokenOf, rootOf, memo, dirs, removed, starts>>

LivePids == {pidOf[p] : p \in live}

DirName(d) == <<d.pid, d.token, d.root>>

Init ==
    /\ live = {}
    /\ pidOf = [p \in ProcIds |-> 0]
    /\ tokenOf = [p \in ProcIds |-> 0]
    /\ rootOf = [p \in ProcIds |-> "none"]
    /\ memo = [r \in Roots |-> "unknown"]
    /\ dirs = {}
    /\ removed = {}
    /\ starts = 0

(* The classifier memo is intentionally separate from the token.  Once a
   root has been classified, later calls in this process do not move it to a
   different data-dir policy. *)
Classify(r, answer) ==
    /\ r \in Roots
    /\ answer \in {"ephemeral", "normal"}
    /\ memo[r] = "unknown"
    /\ memo' = [memo EXCEPT ![r] = answer]
    /\ UNCHANGED <<live, pidOf, tokenOf, rootOf, dirs, removed, starts>>

Start(p, pid, r) ==
    /\ p \in ProcIds
    /\ pid \in Pids
    /\ r \in Roots
    /\ p \notin live
    /\ pid \notin LivePids
    /\ memo[r] = "ephemeral"
    /\ starts < MaxStarts
    /\ live' = live \cup {p}
    /\ pidOf' = [pidOf EXCEPT ![p] = pid]
    /\ tokenOf' = [tokenOf EXCEPT ![p] = IF UniqueToken THEN starts + 1 ELSE pid]
    /\ rootOf' = [rootOf EXCEPT ![p] = r]
    /\ dirs' = dirs \cup
        {[pid |-> pid,
          token |-> IF UniqueToken THEN starts + 1 ELSE pid,
          root |-> r,
          owner |-> p]}
    /\ starts' = starts + 1
    /\ UNCHANGED <<memo, removed>>

Stop(p) ==
    /\ p \in live
    /\ live' = live \ {p}
    /\ UNCHANGED <<pidOf, tokenOf, rootOf, memo, dirs, removed, starts>>

Sweep(d) ==
    /\ d \in dirs
    /\ (SafeSweep => d.pid \notin LivePids)
    /\ dirs' = dirs \ {d}
    /\ removed' = removed \cup {d}
    /\ UNCHANGED <<live, pidOf, tokenOf, rootOf, memo, starts>>

Skip == UNCHANGED vars

Next ==
    \/ \E r \in Roots, answer \in {"ephemeral", "normal"} : Classify(r, answer)
    \/ \E p \in ProcIds, pid \in Pids, r \in Roots : Start(p, pid, r)
    \/ \E p \in ProcIds : Stop(p)
    \/ \E d \in dirs : Sweep(d)
    \/ Skip

TypeOK ==
    /\ live \subseteq ProcIds
    /\ pidOf \in [ProcIds -> (Pids \cup {0})]
    /\ tokenOf \in [ProcIds -> Nat]
    /\ rootOf \in [ProcIds -> (Roots \cup {"none"})]
    /\ memo \in [Roots -> Classifications]
    /\ starts \in Nat

NoSharedEphemeralDir ==
    \A p \in live, d \in dirs : d.owner # p =>
        DirName([pid |-> pidOf[p], token |-> tokenOf[p], root |-> rootOf[p]]) #
        DirName(d)

SweepOnlyDead ==
    \A d \in removed : d.owner \notin live

Spec == Init /\ [][Next]_vars

=============================================================================
