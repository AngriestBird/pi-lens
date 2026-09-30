-------------------------- MODULE SessionLifecycle --------------------------
(***************************************************************************)
(* The composition layer of #3609: one process's session-scoped stores     *)
(* across every pi session transition, with the lineage fence of the       *)
(* design's `clients/session-scope.ts` (a scope ticket plus a branch       *)
(* epoch).                                                                 *)
(*                                                                         *)
(* Content-level truth stays in the sibling models (ReadGuard,             *)
(* SessionStraddle, FormatDrain, SessionRegistry). Here a store's content  *)
(* is abstracted to FACTS [e: entry, o: origin scope]: "scope o recorded   *)
(* something about the tool result at conversation entry e". The read      *)
(* guard (RG) is the fact store; the turn counter (TC), the widget's       *)
(* write-order guard (WG), the LSP fleet (LS) and the registry entry (RE)  *)
(* are small counters or sets beside it.                                   *)
(*                                                                         *)
(* Host transitions (pi 0.85.1, design section 1.1):                       *)
(*   /new, resume, /fork, /clone : session_before_fork (fork, clone only), *)
(*       session_shutdown, then a NEW activation's session_start. The two *)
(*       halves are separate steps, so writers can land between them.      *)
(*   /reload       : the same, same session file, and the entry module    *)
(*       may be re-evaluated (jiti fallback, section 1.3: N3).             *)
(*   quit, pi --fork: the process exits; pi --fork starts a new process    *)
(*       whose only channel is the parent's sidecar.                       *)
(*   /tree         : no new activation; the branch shrinks, epoch bumps.   *)
(*   LSP idle reset: pi-lens' own timer; resets the LSP service only.      *)
(*   secondary start/stop: an in-process subagent binds its own session    *)
(*       while the primary is live (I6).                                   *)
(*                                                                         *)
(* Writers begin in a live scope and land at ANY later step. pi refuses    *)
(* /tree and /reload while streaming, but agent_settled handlers run after *)
(* the run is marked inactive (I1) and bounded handlers are abandoned      *)
(* without being cancelled (I2), so this over-approximation hides nothing  *)
(* the host allows.                                                        *)
(*                                                                         *)
(* Policy, Fence and SecPolicy are the design's section 4 table as         *)
(* constants; a config picks TargetPolicy or TodayPolicy and so on.        *)
(* FixParts selects the mechanisms:                                        *)
(*   "entryCapture"      writers capture their lineage handle at hook      *)
(*                       entry (D2); without it the handle is resolved     *)
(*                       when the write lands, from the module-level       *)
(*                       runtime (or, for the heartbeat, the registry      *)
(*                       intent), as today's unguarded writers do          *)
(*   "handoffAtShutdown" the hand-off slot is written at session_shutdown  *)
(*                       with targetSessionFile (D3); without it, at       *)
(*                       session_before_fork (the G10 design)              *)
(*   "consumeOnMatch"    a session_start consumes the slot only when it    *)
(*                       matches (maintainer decision on F2, amending      *)
(*                       section 3.4); an unmatched slot stays in place.   *)
(*                       Without it, every start takes the slot (section   *)
(*                       3.4 as written) and discards it when unmatched    *)
(*   "processOrderTurn"  the write-order turn is a process counter (the    *)
(*                       design's nextOrderTurn); without it, a field of   *)
(*                       each entry-module evaluation (G5 _writeOrderTurn) *)
(*   "dedupe"            the #2890 duplicate session_start gate            *)
(*   "recordDrop"        a dropped read-guard write whose entry is still   *)
(*                       on its conversation's branch leaves a record (the *)
(*                       maintainer decision on F1: the drop stays, and    *)
(*                       is counted in the degradation ledger)             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Transitions,    \* the host transitions this config enables, a subset of
                    \*   {"New","Resume","Fork","Clone","CancelFork","Reload",
                    \*    "Quit","PiFork","Tree","IdleReset","SecStart",
                    \*    "SecEnd","Dup"}
    Writers,        \* the writers in play, a subset of
                    \*   {"read","secRead","heartbeat","lsp","widget"}
    FixParts,       \* see the header
    MaxSteps,       \* bound on host transitions
    MaxTurns,       \* bound on turn_start events (primary and secondary)
    LateHandlers,   \* TRUE: a read-guard writer may hold any entry of its
                    \*   branch, so its handler outlived a later entry;
                    \*   FALSE: it holds the branch's newest entry
    Policy(_, _),   \* [store, reason] -> action
    Fence(_),       \* store -> "branch" | "session" | "service" | "none"
    SecPolicy(_)    \* store -> "own" | "shared" | "primaryOnly"

Has(p) == p \in FixParts

-----------------------------------------------------------------------------
(* The policy tables (design section 4, maintainer decisions D1-D8).       *)

Starts  == {"startup", "new", "resume", "fork", "clone", "piFork", "reload"}
Reasons == Starts \cup {"tree", "shutdown", "idle"}
Actions == {"reset", "carry", "filter-by-branch", "import-parent",
            "rehydrate", "none"}

\* RG is the read guard, reads and authorship together (D5: authorship
\* carries on /reload). TC: turn counters and per-turn maps. WG: the widget's
\* write-order guards. LS: the LSP fleet. LT: the lens toggles (D6 is not
\* approved: today's per-activation reset). LZ: lazy-tool memory (D7: keep).
\* LT and LZ carry no model state; they are listed so the table is whole.
TargetPolicy(s, r) ==
    CASE s = "RG" ->
            [startup |-> "rehydrate", new |-> "reset", resume |-> "rehydrate",
             fork |-> "import-parent", clone |-> "import-parent",
             piFork |-> "import-parent", tree |-> "filter-by-branch",
             reload |-> "filter-by-branch", shutdown |-> "none",
             idle |-> "none"][r]
      [] s \in {"TC", "LT"} -> IF r \in Starts THEN "reset" ELSE "none"
      [] s = "WG" -> IF r \in {"tree", "reload"} THEN "carry"
                     ELSE IF r \in Starts THEN "reset" ELSE "none"
      [] s = "LZ" -> IF r \in {"startup", "resume"} THEN "rehydrate"
                     ELSE IF r \in {"fork", "clone", "piFork"} THEN "import-parent"
                     ELSE IF r = "reload" THEN "carry"
                     ELSE IF r = "new" THEN "reset" ELSE "none"
      [] s = "LS" -> IF r \in {"shutdown", "idle"} THEN "reset" ELSE "none"

\* Today's master (df5fb8abb). The read guard: resetForSession on every
\* primary session_start (runtime-session.ts:2463), so /reload resets it
\* (N1); the fork stash is an activation-closure `let` (index.ts:1078), which
\* the fork's new activation cannot see, so /fork and /clone start clean; no
\* session_tree handler, so /tree leaves it as it is.
TodayPolicy(s, r) ==
    IF s = "RG"
    THEN [startup |-> "rehydrate", new |-> "reset", resume |-> "rehydrate",
          fork |-> "reset", clone |-> "reset", piFork |-> "reset",
          tree |-> "none", reload |-> "reset", shutdown |-> "none",
          idle |-> "none"][r]
    ELSE TargetPolicy(s, r)

TargetFence(s) ==
    CASE s = "RG" -> "branch" [] s = "TC" -> "session"
      [] s = "LS" -> "service" [] OTHER -> "none"

\* Today: G5's handles (#3568, #3576) fence at session level only.
TodayFence(s) == IF s = "RG" THEN "session" ELSE TargetFence(s)

TargetSec(s) ==
    CASE s \in {"RG", "TC"} -> "own" [] OTHER -> "shared"

\* Today: a subagent's handlers reach the module-level `runtime`, so its
\* read guard and turn counter are the primary's (#3607, N2).
TodaySec(s) == "shared"

-----------------------------------------------------------------------------
(* The world.                                                              *)

Tickets == 1..(MaxSteps + 2)
Files   == {"A", "N", "F", "C", "P", "S"}   \* initial, /new, /fork, /clone,
                                            \* pi --fork, the subagent's
Entries == 1..4
Facts   == [e : Entries, o : Tickets]
FlightIds == Writers \ {"widget"}

InitBranch(f) ==
    CASE f = "A" -> {1, 2} [] f = "N" -> {3} [] f = "S" -> {4} [] OTHER -> {}

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
\* /fork restarts before the chosen user message: the copied branch loses its
\* last entry. /clone copies the whole branch.
ForkBranch(b) == IF b = {} THEN {} ELSE b \ {Max(b)}

NoSlot == [has |-> FALSE, from |-> 0, file |-> "-", target |-> "-",
           facts |-> {}, takenBy |-> 0]
NoPend == [k |-> "none", from |-> 0, file |-> "-", target |-> "-"]
IdleW  == [pc |-> "idle", s |-> 0, ep |-> 0, e |-> 0, svc |-> 0]

RegOn   == "heartbeat" \in Writers
LspOn   == "lsp" \in Writers
TurnsOn == MaxTurns > 0

VARIABLES
    st, role, sess, ep,      \* scope table: state, role, session file, branch epoch
    primary,                 \* the live primary scope, 0 between shutdown and start
    last,                    \* the scope the module-level runtime serves
    nxt,                     \* next ticket (process-unique, design section 3.3)
    pend,                    \* a replacement between its shutdown and its start
    forking,                 \* "no" | "fork" | "clone": after session_before_fork
    branch,                  \* file -> entries on its current branch
    cell,                    \* scope -> RG facts (D1: cells live in the registry)
    imp,                     \* scope -> facts it inherited (hand-off, sidecar, forward)
    lin,                     \* file -> the scopes whose conversation its history
                             \* holds (/fork, /clone and pi --fork copy it); the
                             \* truth the invariants check, whatever the policy
    slot,                    \* the process hand-off slot
    side, sideOwner,         \* per-file sidecar: facts; the scope that saved it
    wr,                      \* in-flight writers
    entry, intent, reg,      \* registry: roots in this process's entry, the
                             \* re-registration intent, per-scope registration
    svc, fleet,              \* LSP service generation; servers [g: generation, o]
    turn, begun, turns,      \* turn counters, turn_starts each scope issued, total
    procTurn, evalTurn,      \* the order turn: process-wide, per evaluation
    wgTok, wgDone,           \* the widget guard's stored token; written this turn
    lastTok, prevMax,        \* the last order token drawn, the max before it
    ownDrop,                 \* a guard dropped a write whose own lineage was current
    recorded,                \* dropped RG facts that left a degradation record
    resets, dupDone,         \* session_start mutation passes per scope; dup seen
    landed, reads,           \* RG facts that reached a cell; RG writes completed
    predOf,                  \* scope -> the scope its session_start replaced
    steps, used

vars == <<st, role, sess, ep, primary, last, nxt, pend, forking, branch, cell,
          imp, lin, slot, side, sideOwner, wr, entry, intent,
          reg, svc, fleet, turn, begun, turns, procTurn, evalTurn, wgTok,
          wgDone, lastTok, prevMax, ownDrop, recorded, resets, dupDone, landed,
          reads, predOf, steps, used>>

Init ==
    /\ st = [t \in Tickets |-> IF t = 1 THEN "live" ELSE "free"]
    /\ role = [t \in Tickets |-> IF t = 1 THEN "primary" ELSE "-"]
    /\ sess = [t \in Tickets |-> IF t = 1 THEN "A" ELSE "-"]
    /\ ep = [t \in Tickets |-> 0]
    /\ primary = 1 /\ last = 1 /\ nxt = 2
    /\ pend = NoPend /\ forking = "no"
    /\ branch = [f \in Files |-> InitBranch(f)]
    /\ cell = [t \in Tickets |-> {}]
    /\ imp = [t \in Tickets |-> {}]
    /\ lin = [f \in Files |-> IF f = "A" THEN {1} ELSE {}]
    /\ slot = NoSlot
    /\ side = [f \in Files |-> {}]
    /\ sideOwner = [f \in Files |-> 0]
    /\ wr = [x \in FlightIds |-> IdleW]
    /\ entry = IF RegOn THEN {1} ELSE {}
    /\ intent = IF RegOn THEN 1 ELSE 0
    /\ reg = [t \in Tickets |-> IF t = 1 /\ RegOn THEN "done" ELSE "-"]
    /\ svc = 0 /\ fleet = {}
    /\ turn = [t \in Tickets |-> 0] /\ begun = [t \in Tickets |-> 0]
    /\ turns = 0 /\ procTurn = 0 /\ evalTurn = 0
    /\ wgTok = 0 /\ wgDone = FALSE /\ lastTok = 0 /\ prevMax = 0
    /\ ownDrop = FALSE /\ recorded = {}
    /\ resets = [t \in Tickets |-> IF t = 1 THEN 1 ELSE 0]
    /\ dupDone = FALSE
    /\ landed = {} /\ reads = {}
    /\ predOf = [t \in Tickets |-> 0]
    /\ steps = 0 /\ used = {}

-----------------------------------------------------------------------------
(* Helpers.                                                                *)

\* The cell an RG write of scope t reaches: its own, or, when the store is
\* shared with secondaries (today), the one the module-level runtime serves.
CellOf(t) == IF role[t] = "secondary" /\ SecPolicy("RG") = "shared"
             THEN last ELSE t

Ents(S) == {x.e : x \in S}

\* The order token a turn draws, and the counter it advances.
OrderNow == IF Has("processOrderTurn") THEN procTurn ELSE evalTurn

Draw ==
    /\ IF Has("processOrderTurn")
       THEN /\ procTurn' = procTurn + 1 /\ UNCHANGED evalTurn
            /\ lastTok' = procTurn + 1
       ELSE /\ evalTurn' = evalTurn + 1 /\ UNCHANGED procTurn
            /\ lastTok' = evalTurn + 1
    /\ prevMax' = IF lastTok > prevMax THEN lastTok ELSE prevMax
    /\ wgDone' = FALSE

HostOk == pend.k = "none" /\ forking = "no" /\ primary # 0 /\ steps < MaxSteps

-----------------------------------------------------------------------------
(* Host transitions.                                                       *)

\* session_before_fork (0 ms, may not await). The G10 design snapshots the
\* read guard into the slot here.
BeforeFork(k) ==
    /\ (k = "fork" /\ "Fork" \in Transitions)
       \/ (k = "clone" /\ "Clone" \in Transitions)
    /\ k \notin used
    /\ HostOk
    /\ forking' = k
    /\ slot' = IF Has("handoffAtShutdown") THEN slot
               ELSE [has |-> TRUE, from |-> primary, file |-> sess[primary],
                     target |-> "-", facts |-> cell[primary], takenBy |-> 0]
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, branch, cell,
                   imp, lin, side, sideOwner, wr, entry,
                   intent, reg, svc, fleet, turn, begun, turns, procTurn,
                   evalTurn, wgTok, wgDone, lastTok, prevMax, ownDrop, recorded, resets,
                   dupDone, landed, reads, predOf, steps, used>>

\* Another extension cancels the fork after pi-lens' handler ran (I3).
CancelFork ==
    /\ "CancelFork" \in Transitions /\ forking # "no" /\ steps < MaxSteps
    /\ forking' = "no" /\ steps' = steps + 1
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, branch, cell,
                   imp, lin, slot, side, sideOwner, wr, entry,
                   intent, reg, svc, fleet, turn, begun, turns, procTurn,
                   evalTurn, wgTok, wgDone, lastTok, prevMax, ownDrop, recorded, resets,
                   dupDone, landed, reads, predOf, used>>

TargetOf(k) ==
    CASE k = "new" -> "N" [] k = "resume" -> "A" [] k = "fork" -> "F"
      [] k = "clone" -> "C" [] OTHER -> "-"

RetireOk(k) ==
    /\ pend.k = "none" /\ primary # 0 /\ steps < MaxSteps /\ k \notin used
    /\ CASE k = "fork"   -> forking = "fork"
         [] k = "clone"  -> forking = "clone"
         [] k = "new"    -> forking = "no" /\ "New" \in Transitions
         [] k = "resume" -> forking = "no" /\ "Resume" \in Transitions
                            /\ sess[primary] # "A"
         [] k = "reload" -> forking = "no" /\ "Reload" \in Transitions
         [] k = "quit"   -> forking = "no" /\ "Quit" \in Transitions

\* session_shutdown: the design's retireScope (sync, 0 ms). Snapshot into the
\* slot (D3), persist the sidecar, retire the scope, deregister the root,
\* reset the LSP service. `quit` ends the process: in-flight work dies.
Retire(k) ==
    /\ RetireOk(k)
    /\ LET p == primary
           quit == k = "quit"
       IN
       /\ st' = [t \in Tickets |->
                   IF t = p \/ (quit /\ st[t] = "live") THEN "retired" ELSE st[t]]
       /\ primary' = 0
       /\ slot' = IF Has("handoffAtShutdown")
                  THEN [has |-> TRUE, from |-> p, file |-> sess[p],
                        target |-> TargetOf(k), facts |-> cell[p],
                        takenBy |-> 0]
                  ELSE slot
       /\ side' = [side EXCEPT ![sess[p]] = cell[p]]
       /\ sideOwner' = [sideOwner EXCEPT ![sess[p]] = p]
       /\ entry' = entry \ {p}
       /\ IF LspOn /\ Policy("LS", "shutdown") = "reset"
          THEN svc' = svc + 1 /\ fleet' = {}
          ELSE UNCHANGED <<svc, fleet>>
       /\ wr' = IF quit
                THEN [x \in FlightIds |->
                        IF wr[x].pc = "flight" THEN [wr[x] EXCEPT !.pc = "dead"]
                        ELSE wr[x]]
                ELSE wr
       /\ pend' = [k |-> k, from |-> p, file |-> sess[p], target |-> TargetOf(k)]
       /\ forking' = "no"
       /\ steps' = steps + 1
       /\ used' = used \cup {k}
    /\ UNCHANGED <<role, sess, ep, last, nxt, branch, cell, imp, lin,
                   intent, reg, turn, begun, turns, procTurn, evalTurn, wgTok,
                   wgDone, lastTok, prevMax, ownDrop, recorded, resets, dupDone, landed,
                   reads, predOf>>

NewFile(k) == IF k = "reload" THEN pend.file ELSE TargetOf(k)

\* The design's match (section 3.4): the slot names the taker's previous
\* session file and, under D3, the targetSessionFile the host replaced it
\* with. A primary start passes its pending replacement. A subagent's start
\* is not a replacement: it has no previous file, and its own file is "S".
SlotMatch(prev, tgt) ==
    /\ slot.has /\ slot.takenBy = 0
    /\ slot.file = prev
    /\ (Has("handoffAtShutdown") => slot.target = tgt)

\* session_start of the new activation: the design's beginScope. It takes
\* the slot once, then runs each store's action. In-process under D3 the
\* slot it finds is always its predecessor's, so it always matches (F3).
Begin ==
    /\ pend.k \in {"new", "resume", "fork", "clone", "reload"}
    /\ LET k == pend.k
           t == nxt
           f == NewFile(k)
           nb == CASE k = "fork"  -> ForkBranch(branch[pend.file])
                   [] k = "clone" -> branch[pend.file]
                   [] OTHER       -> branch[f]
           a == Policy("RG", k)
           match == SlotMatch(pend.file, pend.target)
           src == IF a \in {"carry", "filter-by-branch", "import-parent"} /\ match
                  THEN "slot"
                  ELSE IF a = "import-parent" THEN "parent"
                  ELSE IF a = "rehydrate" THEN "own"
                  ELSE "none"
           base == CASE src = "slot"   -> slot.facts
                     [] src = "parent" -> side[pend.file]
                     [] src = "own"    -> side[f]
                     [] OTHER          -> {}
           kept == IF a = "carry" THEN base ELSE {x \in base : x.e \in nb}
       IN
       /\ st' = [st EXCEPT ![t] = "live"]
       /\ role' = [role EXCEPT ![t] = "primary"]
       /\ sess' = [sess EXCEPT ![t] = f]
       /\ primary' = t /\ last' = t /\ nxt' = t + 1
       /\ branch' = [branch EXCEPT ![f] = nb]
       /\ cell' = [cell EXCEPT ![t] = kept]
       /\ imp' = [imp EXCEPT ![t] = kept]
       /\ lin' = IF k \in {"fork", "clone"}
                 THEN [lin EXCEPT ![f] = lin[pend.file] \cup {t}]
                 ELSE [lin EXCEPT ![f] = @ \cup {t}]
       /\ slot' = IF slot.has /\ slot.takenBy = 0
                  THEN [slot EXCEPT !.takenBy = t] ELSE slot
       /\ reg' = IF RegOn THEN [reg EXCEPT ![t] = "queued"] ELSE reg
       /\ wgTok' = IF Policy("WG", k) = "reset" THEN 0 ELSE wgTok
       \* /reload re-evaluates the entry module when jiti's native import
       \* fails (section 1.3); the order turn of G5 is a field of it.
       /\ IF k = "reload" /\ TurnsOn
          THEN \E reEval \in BOOLEAN :
                   evalTurn' = IF reEval THEN 0 ELSE evalTurn
          ELSE UNCHANGED evalTurn
       /\ resets' = [resets EXCEPT ![t] = 1]
       /\ predOf' = [predOf EXCEPT ![t] = pend.from]
       /\ pend' = NoPend
    /\ UNCHANGED <<ep, forking, side, sideOwner, wr, entry, intent,
                   svc, fleet, turn, begun, turns, procTurn, wgDone, lastTok,
                   prevMax, ownDrop, recorded, dupDone, landed, reads, steps, used>>

\* pi --fork <path>: a new process after this one quit. The header names the
\* parent; the parent's sidecar is the only channel.
PiFork ==
    /\ "PiFork" \in Transitions /\ pend.k = "quit" /\ steps < MaxSteps
    /\ LET t == nxt
           src == pend.file
           nb == branch[src]
           a == Policy("RG", "piFork")
           base == IF a = "import-parent" THEN side[src] ELSE {}
       IN
       /\ st' = [st EXCEPT ![t] = "live"]
       /\ role' = [role EXCEPT ![t] = "primary"]
       /\ sess' = [sess EXCEPT ![t] = "P"]
       /\ primary' = t /\ last' = t /\ nxt' = t + 1
       /\ branch' = [branch EXCEPT !["P"] = nb]
       /\ cell' = [cell EXCEPT ![t] = {x \in base : x.e \in nb}]
       /\ imp' = [imp EXCEPT ![t] = {x \in base : x.e \in nb}]
       /\ lin' = [lin EXCEPT !["P"] = lin[src] \cup {t}]
       /\ slot' = NoSlot
       /\ entry' = {} /\ intent' = 0
       /\ reg' = IF RegOn THEN [reg EXCEPT ![t] = "queued"] ELSE reg
       /\ fleet' = {}
       /\ procTurn' = 0 /\ evalTurn' = 0 /\ wgTok' = 0 /\ lastTok' = 0
       /\ prevMax' = 0
       /\ resets' = [resets EXCEPT ![t] = 1]
       /\ predOf' = [predOf EXCEPT ![t] = pend.from]
       /\ pend' = NoPend
       /\ steps' = steps + 1 /\ used' = used \cup {"piFork"}
    /\ UNCHANGED <<ep, forking, side, sideOwner, wr, svc, turn,
                   begun, turns, wgDone, ownDrop, recorded, dupDone, landed, reads>>

\* /tree: the same activation. The branch loses its last entry and the
\* branch epoch bumps (G10's epoch, moved into the scope by S1).
Tree ==
    /\ "Tree" \in Transitions /\ HostOk /\ "tree" \notin used
    /\ LET p == primary
           f == sess[p]
           nb == branch[f] \ {Max(branch[f])}
           a == Policy("RG", "tree")
       IN
       /\ Cardinality(branch[f]) = 2
       /\ branch' = [branch EXCEPT ![f] = nb]
       /\ ep' = [ep EXCEPT ![p] = @ + 1]
       /\ cell' = CASE a = "filter-by-branch"
                         -> [cell EXCEPT ![p] = {x \in @ : x.e \in nb}]
                    [] a = "reset" -> [cell EXCEPT ![p] = {}]
                    [] OTHER -> cell
       /\ steps' = steps + 1 /\ used' = used \cup {"tree"}
    /\ UNCHANGED <<st, role, sess, primary, last, nxt, pend, forking, imp, lin,
                   slot, side, sideOwner, wr, entry, intent,
                   reg, svc, fleet, turn, begun, turns, procTurn, evalTurn,
                   wgTok, wgDone, lastTok, prevMax, ownDrop, recorded, resets, dupDone,
                   landed, reads, predOf>>

\* The LSP idle reset: pi-lens' own timer, not a host event. It resets the
\* LSP service and nothing session-scoped (#3576).
IdleReset ==
    /\ "IdleReset" \in Transitions /\ steps < MaxSteps /\ "idle" \notin used
    /\ IF Policy("LS", "idle") = "reset"
       THEN svc' = svc + 1 /\ fleet' = {}
       ELSE UNCHANGED <<svc, fleet>>
    /\ steps' = steps + 1 /\ used' = used \cup {"idle"}
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, side,
                   sideOwner, wr, entry, intent, reg, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, resets, dupDone, landed, reads, predOf>>

\* A concurrent secondary binds (I6). It skips handleSessionStart (#473) and
\* gets fresh own cells. Its beginScope calls takeHandoff() like any start.
\* Section 3.4 as written takes the slot and discards it as unmatched; with
\* consumeOnMatch the unmatched slot stays in place for the primary.
SecStart ==
    /\ "SecStart" \in Transitions /\ steps < MaxSteps /\ "secStart" \notin used
    /\ LET t == nxt IN
       /\ st' = [st EXCEPT ![t] = "live"]
       /\ role' = [role EXCEPT ![t] = "secondary"]
       /\ sess' = [sess EXCEPT ![t] = "S"]
       /\ lin' = [lin EXCEPT !["S"] = {t}]
       /\ nxt' = t + 1
       /\ LET takes == IF Has("consumeOnMatch") THEN SlotMatch("-", "S")
                        ELSE slot.has /\ slot.takenBy = 0
          IN slot' = IF takes THEN [slot EXCEPT !.takenBy = t] ELSE slot
    /\ steps' = steps + 1 /\ used' = used \cup {"secStart"}
    /\ UNCHANGED <<ep, primary, last, pend, forking, branch, cell, imp,
                   side, sideOwner, wr, entry, intent, reg, svc,
                   fleet, turn, begun, turns, procTurn, evalTurn, wgTok,
                   wgDone, lastTok, prevMax, ownDrop, recorded, resets, dupDone, landed,
                   reads, predOf>>

\* The secondary's session_shutdown: its scope retires and its own cells go.
SecEnd ==
    /\ "SecEnd" \in Transitions /\ steps < MaxSteps
    /\ \E s \in Tickets :
          /\ st[s] = "live" /\ role[s] = "secondary"
          /\ st' = [st EXCEPT ![s] = "retired"]
          /\ cell' = [cell EXCEPT ![s] = {}]
    /\ steps' = steps + 1
    /\ UNCHANGED <<role, sess, ep, primary, last, nxt, pend, forking, branch,
                   imp, lin, slot, side, sideOwner, wr, entry,
                   intent, reg, svc, fleet, turn, begun, turns, procTurn,
                   evalTurn, wgTok, wgDone, lastTok, prevMax, ownDrop, recorded, resets,
                   dupDone, landed, reads, predOf, used>>

\* A duplicate session_start for the same replacement (I5, #2890).
Dup ==
    /\ "Dup" \in Transitions /\ HostOk /\ ~dupDone
    /\ dupDone' = TRUE
    /\ IF Has("dedupe")
       THEN UNCHANGED <<resets, cell>>
       ELSE /\ resets' = [resets EXCEPT ![primary] = @ + 1]
            /\ cell' = [cell EXCEPT ![primary] = {}]
    /\ steps' = steps + 1
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, forking,
                   branch, imp, lin, slot, side, sideOwner, wr,
                   entry, intent, reg, svc, fleet, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, landed, reads, predOf, used>>

-----------------------------------------------------------------------------
(* Turns and the widget's write-order guard.                               *)

TurnStart ==
    /\ turns < MaxTurns /\ primary # 0 /\ pend.k = "none"
    /\ turn' = [turn EXCEPT ![primary] = @ + 1]
    /\ begun' = [begun EXCEPT ![primary] = @ + 1]
    /\ turns' = turns + 1
    /\ Draw
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, side,
                   sideOwner, wr, entry, intent, reg, svc, fleet, wgTok,
                   ownDrop, recorded, resets, dupDone, landed, reads, predOf, steps,
                   used>>

\* A secondary's turn_start. Today onTurnStart calls runtime.beginTurn() with
\* no role gate (index.ts:2817-2829), which advances the primary's turn.
SecTurn ==
    /\ turns < MaxTurns
    /\ \E s \in Tickets :
          /\ st[s] = "live" /\ role[s] = "secondary"
          /\ LET tgt == IF SecPolicy("TC") = "own" THEN s ELSE last IN
             turn' = [turn EXCEPT ![tgt] = @ + 1]
          /\ begun' = [begun EXCEPT ![s] = @ + 1]
    /\ turns' = turns + 1
    /\ Draw
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, side,
                   sideOwner, wr, entry, intent, reg, svc, fleet, wgTok,
                   ownDrop, recorded, resets, dupDone, landed, reads, predOf, steps,
                   used>>

\* A pipeline verdict write to the widget in the current turn. The guard
\* (a clients/ module, R3: it survives an entry re-evaluation) accepts a token
\* no older than the stored one.
WidgetWrite ==
    /\ "widget" \in Writers /\ primary # 0 /\ pend.k = "none"
    /\ begun[primary] > 0 /\ ~wgDone
    /\ wgDone' = TRUE
    /\ IF OrderNow >= wgTok
       THEN wgTok' = OrderNow /\ UNCHANGED ownDrop
       ELSE ownDrop' = TRUE /\ UNCHANGED wgTok
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, side,
                   sideOwner, wr, entry, intent, reg, svc, fleet, turn, begun,
                   turns, procTurn, evalTurn, lastTok, prevMax, recorded, resets,
                   dupDone, landed, reads, predOf, steps, used>>

-----------------------------------------------------------------------------
(* Writers: each begins once in a live scope and lands at any later step.   *)

\* "read": a read-guard write of the primary: a tool_result handler's read
\* record or recordWritten (#3596), or the agent_settled drain's (G10 F1).
\* "secRead": the same in a secondary. "heartbeat": the registry heartbeat's
\* repair. "lsp": LSP work that can spawn a server (#3576).
\* The entry a writer holds. A handler that has not outlived a later entry
\* holds its branch's newest one (LateHandlers = FALSE).
Held(x, s) ==
    IF x \notin {"read", "secRead"} THEN {1}
    ELSE IF LateHandlers \/ branch[sess[s]] = {} THEN branch[sess[s]]
    ELSE {Max(branch[sess[s]])}

WriterBegin(x) ==
    /\ x \in FlightIds /\ wr[x].pc = "idle"
    /\ \E s \in Tickets :
          /\ st[s] = "live"
          /\ IF x = "secRead" THEN role[s] = "secondary" ELSE s = primary
          /\ \E e \in Held(x, s) :
                wr' = [wr EXCEPT ![x] = [pc |-> "flight", s |-> s, ep |-> ep[s],
                                         e |-> e, svc |-> svc]]
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, side,
                   sideOwner, entry, intent, reg, svc, fleet, turn, begun,
                   turns, procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, resets, dupDone, landed, reads, predOf, steps,
                   used>>

LandRead(x) ==
    /\ x \in {"read", "secRead"} /\ x \in FlightIds /\ wr[x].pc = "flight"
    /\ LET w == wr[x]
           captured == Has("entryCapture") \/ x = "secRead"
           hs == IF captured THEN w.s ELSE last
           hep == IF captured THEN w.ep ELSE ep[last]
           f == [e |-> w.e, o |-> w.s]
           current == st[hs] = "live" /\ (Fence("RG") = "branch" => ep[hs] = hep)
           lineageCurrent == st[w.s] = "live" /\ ep[w.s] = w.ep
       IN
       /\ reads' = reads \cup {f}
       /\ IF current
          THEN /\ cell' = [cell EXCEPT ![CellOf(hs)] = @ \cup {f}]
               /\ landed' = landed \cup {f}
               /\ wr' = [wr EXCEPT ![x].pc = "landed"]
               /\ UNCHANGED <<ownDrop, recorded>>
          ELSE /\ wr' = [wr EXCEPT ![x].pc = "dropped"]
               /\ ownDrop' = (ownDrop \/ lineageCurrent)
               \* F1's record: the dropped entry is still on the branch of
               \* the writer's conversation, so a live scope may hold it.
               /\ recorded' = IF Has("recordDrop") /\ w.e \in branch[sess[w.s]]
                               THEN recorded \cup {f} ELSE recorded
               /\ UNCHANGED <<cell, landed>>
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, forking,
                   branch, imp, lin, slot, side, sideOwner, entry, intent, reg,
                   svc, fleet, turn, begun, turns, procTurn, evalTurn, wgTok,
                   wgDone, lastTok, prevMax, resets, dupDone, predOf, steps,
                   used>>

\* The heartbeat re-registers a missing root. Without a captured handle it
\* takes the root from the process-wide intent, which the new session's
\* queued registration has not yet overwritten ("heartbeat before
\* registration", the pre-#3498 shape; the lock-level detail is
\* formal/session-registry).
LandHeartbeat ==
    /\ "heartbeat" \in FlightIds /\ wr["heartbeat"].pc = "flight"
    /\ LET w == wr["heartbeat"]
           root == IF Has("entryCapture") THEN w.s ELSE intent
           ok == root # 0 /\ (Has("entryCapture") => st[w.s] = "live")
       IN
       /\ entry' = IF ok THEN entry \cup {root} ELSE entry
       /\ wr' = [wr EXCEPT !["heartbeat"].pc = IF ok THEN "landed" ELSE "dropped"]
       /\ ownDrop' = (ownDrop \/ (~ok /\ st[w.s] = "live"))
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, side,
                   sideOwner, intent, reg, svc, fleet, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax, recorded,
                   resets, dupDone, landed, reads, predOf, steps, used>>

\* LSP work that outlived its hook calls getLSPService(). With G5's
\* captureLspServiceGeneration it stands down once the service was reset.
LandLsp ==
    /\ "lsp" \in FlightIds /\ wr["lsp"].pc = "flight"
    /\ LET w == wr["lsp"]
           g == IF Has("entryCapture") THEN w.svc ELSE svc
           ok == g = svc
       IN
       /\ fleet' = IF ok THEN fleet \cup {[g |-> w.svc, o |-> w.s]} ELSE fleet
       /\ wr' = [wr EXCEPT !["lsp"].pc = IF ok THEN "landed" ELSE "dropped"]
       /\ ownDrop' = (ownDrop \/ (~ok /\ w.svc = svc))
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, side,
                   sideOwner, entry, intent, reg, svc, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax, recorded,
                   resets, dupDone, landed, reads, predOf, steps, used>>

\* A queued registration lands; the #3498 generation gate drops it once its
\* session ended.
RegLand(t) ==
    /\ reg[t] = "queued"
    /\ IF st[t] = "live"
       THEN /\ entry' = entry \cup {t} /\ intent' = t
            /\ reg' = [reg EXCEPT ![t] = "done"]
       ELSE /\ reg' = [reg EXCEPT ![t] = "dropped"]
            /\ UNCHANGED <<entry, intent>>
    /\ UNCHANGED <<st, role, sess, ep, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, side,
                   sideOwner, wr, svc, fleet, turn, begun, turns, procTurn,
                   evalTurn, wgTok, wgDone, lastTok, prevMax, ownDrop, recorded, resets,
                   dupDone, landed, reads, predOf, steps, used>>

Next ==
    \/ \E k \in {"fork", "clone"} : BeforeFork(k)
    \/ CancelFork
    \/ \E k \in {"new", "resume", "fork", "clone", "reload", "quit"} : Retire(k)
    \/ Begin
    \/ PiFork
    \/ Tree
    \/ IdleReset
    \/ SecStart
    \/ SecEnd
    \/ Dup
    \/ TurnStart
    \/ SecTurn
    \/ WidgetWrite
    \/ \E x \in FlightIds : WriterBegin(x)
    \/ \E x \in FlightIds : LandRead(x)
    \/ LandHeartbeat
    \/ LandLsp
    \/ \E t \in Tickets : RegLand(t)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants.                                                             *)

TypeOK ==
    /\ st \in [Tickets -> {"free", "live", "retired"}]
    /\ role \in [Tickets -> {"-", "primary", "secondary"}]
    /\ \A t \in Tickets : cell[t] \subseteq Facts
    /\ primary \in 0..(MaxSteps + 2)
    /\ \A s \in {"RG", "TC", "WG", "LS", "LT", "LZ"} :
          \A r \in Reasons : Policy(s, r) \in Actions

\* The design's NoCrossScopeWrite (#3528, #3568, #3596, #3576): a live
\* scope's read-guard cell holds only its own facts and the facts it
\* inherited; the registry entry holds only live roots (the #3498 ghost
\* root); every LSP server belongs to the current service generation.
NoCrossSessionState ==
    /\ \A t \in Tickets :
          st[t] = "live" => \A x \in cell[t] : x.o = t \/ x \in imp[t]
    /\ \A r \in entry : st[r] = "live"
    /\ \A srv \in fleet : srv.g = svc

\* The design's NoOffBranchFact (#3521): a live scope's own-lineage facts
\* name entries on its current branch.
NoStaleBranchWrite ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A x \in cell[t] : x.o \in lin[sess[t]] => x.e \in branch[sess[t]]

\* The design's NoLostCarry (shape 54): every fact that reached a cell of the
\* live scope's lineage, on an entry its conversation still holds, is in the
\* cell it reads.
NoLostCarry ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A x \in landed :
                (x.o \in lin[sess[t]] /\ x.e \in branch[sess[t]])
                    => x.e \in Ents(cell[CellOf(t)])

\* The same over every read-guard write that COMPLETED, whether it reached a
\* cell or a guard dropped it: a read whose tool result is in the live
\* conversation authorises an edit there. A violation is a false block. The
\* design accepts it (F1); the AcceptedLateRead* configs pin where it occurs.
NoFalseBlock ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A x \in reads :
                (x.o \in lin[sess[t]] /\ x.e \in branch[sess[t]])
                    => x.e \in Ents(cell[CellOf(t)])

\* F1's decision: every false block left a degradation record.
NoUnrecordedFalseBlock ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A x \in reads \ recorded :
                (x.o \in lin[sess[t]] /\ x.e \in branch[sess[t]])
                    => x.e \in Ents(cell[CellOf(t)])

\* No guard drops a write whose own lineage is still current (shape 54).
NoOwnDrop == ~ownDrop

\* #3607 and N2: a primary transition never removes a live secondary's own
\* facts, and a secondary's turn never moves a primary's turn.
SecondaryIsolation ==
    /\ \A s \in Tickets :
          (st[s] = "live" /\ role[s] = "secondary")
              => {x \in landed : x.o = s} \subseteq cell[CellOf(s)]
    /\ \A p \in Tickets :
          (st[p] = "live" /\ role[p] = "primary") => turn[p] = begun[p]

\* The slot is consumed at most once, and only by the start that replaced
\* the scope that wrote it.
HandoffOnce ==
    (slot.has /\ slot.takenBy # 0)
        => role[slot.takenBy] = "primary" /\ predOf[slot.takenBy] = slot.from

\* #3540 case A, N3: a token drawn later outranks every earlier one, across
\* /reload and entry-module evaluations.
OrderMonotone == lastTok = 0 \/ prevMax < lastTok

\* #2890: one session_start mutation pass per scope.
OneResetPerScope == \A t \in Tickets : resets[t] <= 1

\* A live scope's cell holds only facts of its own conversation lineage, on
\* its current branch (proposed in the S9 review). The invariants above take
\* `x.o \in lin[...]` as a premise, so a lineage truth that omits a scope
\* makes them vacuous for its facts: a /fork that does not copy its parent's
\* lineage passes every other invariant of Fix, and violates this one.
NoForeignFact ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A x \in cell[t] : x.o \in lin[sess[t]] /\ x.e \in branch[sess[t]]

=============================================================================
