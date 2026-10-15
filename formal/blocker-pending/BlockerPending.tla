--------------------------- MODULE BlockerPending ---------------------------
(***************************************************************************
One file F and its inline-blocker record over a session (#4484): which
blockers F's bytes hold, what each post-write dispatch observes, what the
delta calls new, and what the record, the tool result, the commit gate and
the turn-end Resolved line then say.

Findings: "a" and "b" are blockers a fast (inline) runner reports; "d" is a
blocker a collect-later runner reports (Deferred). A finding's id is the one
the delta keys on (dispatcher.ts `filterDelta(..., d => d.id)`):
 - a line-bound id (an LSP id, `lsp:<code>:<line>`,
   clients/dispatch/utils/lsp-diagnostics.ts) is <<finding, line offset>>, so
   a line inserted above it gives it a new id;
 - an ordinal id (Ordinal; helm-lint's `helm-lint-<ordinal>-<level>`,
   clients/dispatch/runners/helm-lint.ts) is its rank in the observation, so
   fixing an earlier finding renumbers the later one onto the fixed one's id.

Actions, each a hook step of the code:
 - Write(new, shift, touched): an authored write/edit and its tool_result
   pipeline, run to the record verb (runtime-tool-result.ts: runPipeline,
   dispatchLintWithResult, recordInlineBlockers or clearInlineBlockers,
   updateGitGuardStatus). `new` is the blocker set of the new bytes, `shift`
   inserts a line above every finding, `touched` the findings on lines the
   write changed (ctx.modifiedRanges). The record verb's ordering under
   parallel writes is dispatch-pipeline's model (InlineFix); here writes are
   sequential;
 - Opaque(new): an unauthored write (an opaque bash recovery, #3226) that
   introduces nothing; its run withholds the blocker channel, so it may only
   keep or clear the record (clearInlineBlockers' `analysis.authored = false`);
 - Settle: the collect-later run of the current bytes settles and its
   blocking finding joins the record (deferred-runner-blockers.ts,
   recordDeferredInlineBlockers), at the commit gate or the turn end's late
   lane, whichever asks first;
 - TurnEnd(settle): handleTurnEnd. The late lane may or may not find the
   deferred run settled; the replay lists the record as Unresolved, and the
   Resolved line names F when a clear noted it and nothing is Unresolved
   (runtime-turn.ts `formatResolvedLine`, held while F is still listed). The
   record carries into the next turn.

Switches:
 - ClearOnCurrent (the #4484 fix, pinned TRUE): the record, the clean text
   and the clear read the current blocking set, the observation's blockers
   whether or not the delta calls them new. FALSE is the code before #4484:
   they read the delta's blockers, so an empty delta clears;
 - OpaqueKeep (the #4484 fix, part 2, pinned TRUE): an unauthored run clears
   the record only when it observes no blocker (clearInlineBlockers'
   `analysis.blocking`). FALSE is the code before #4484: it cleared on any
   new bytes;
 - Delta: FALSE is `--no-delta` (the causal differential);
 - RangeGated: finding "a" comes from a runner that drops blocking matches
   on lines the write did not change (tree-sitter today;
   clients/dispatch/runners/tree-sitter.ts, `blockingOnly`). The observation
   then does not see "a" on an untouched line.

Invariants:
 - GateHonest: the commit gate is open only when no completed observation of
   the current bytes holds a blocker;
 - CleanHonest: a write's tool result says clean only when its observation
   holds no blocker;
 - ResolvedHonest: F is reported resolved only when every blocker the
   cleared record held was observed gone: a fast blocker is absent from the
   bytes the clearing write's runners saw, a deferred one from a settled
   run of the current bytes;
 - GateSound: the gate is open only when the bytes hold no fast blocker
   (stronger than GateHonest: it also catches a blocker a runner does not
   observe).
***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Writes,         \* authored writes of F
    OpaqueWrites,   \* unauthored (opaque recovery) writes of F
    Turns,          \* turn ends
    MaxShift,       \* line insertions above the findings
    Ordinal,        \* TRUE: ids are ordinal ranks (helm-lint); FALSE: line-bound (LSP)
    Deferred,       \* TRUE: the collect-later finding "d" exists
    RangeGated,     \* TRUE: "a" is reported only on a line the write changed
    Delta,          \* FALSE: --no-delta
    ClearOnCurrent, \* the #4484 fix: record/clean/clear read the current blocking set
    OpaqueKeep      \* the #4484 fix, part 2: an unauthored run that still observes a blocker keeps the record

Fast == {"a", "b"}
Def == IF Deferred THEN {"d"} ELSE {}
AllF == Fast \cup Def

\* The id the delta keys on, for finding f in observation obs at line offsets l.
Id(f, obs, l) ==
    IF Ordinal
      THEN <<"ord", IF f = "b" /\ "a" \in obs THEN 2 ELSE 1>>
      ELSE <<f, l[f]>>

IdsOf(obs, l) == {Id(f, obs, l) : f \in obs}

VARIABLES
    disk,       \* the blockers F's bytes hold
    ln,         \* line offset per finding (line-bound ids)
    base,       \* the delta baseline: ids of the previous observation
    hasBase,    \* a previous dispatch stored a baseline
    rec,        \* the inline-blocker record's findings ({} = no record)
    obsF,       \* the latest observation of the current bytes by the fast runners
    wobs,       \* the observation of the latest authored write (its tool result)
    dState,     \* the collect-later run of the current bytes: "idle" | "flight" | "settled"
    toolClean,  \* the latest authored write's tool result says clean
    noted,      \* a clear noted F for the Resolved line, not yet printed
    cleared,    \* the findings the noted clear retired
    claim,      \* the latest turn end printed Resolved for F
    claimSet,   \* the findings that Resolved line claimed gone
    claimOk,    \* each claimed finding was observed gone when the line printed
    nW, nO, nT

vars == <<disk, ln, base, hasBase, rec, obsF, wobs, dState, toolClean, noted,
          cleared, claim, claimSet, claimOk, nW, nO, nT>>

TypeOK ==
    /\ disk \subseteq AllF /\ rec \subseteq AllF /\ obsF \subseteq Fast
    /\ dState \in {"idle", "flight", "settled"}

Init ==
    /\ disk = {} /\ ln = [f \in AllF |-> 0]
    /\ base = {} /\ hasBase = FALSE
    /\ rec = {} /\ obsF = {} /\ wobs = {}
    /\ dState = "idle" /\ toolClean = TRUE
    /\ noted = FALSE /\ cleared = {}
    /\ claim = FALSE /\ claimSet = {} /\ claimOk = TRUE
    /\ nW = 0 /\ nO = 0 /\ nT = 0

\* What the fast runners report for bytes `new` when the write changed `touched`.
Observe(new, touched) ==
    {f \in new \cap Fast : ~(RangeGated /\ f = "a" /\ f \notin touched)}

\* The record verb after one dispatch: record `set`, or clear when it is empty.
\* recordInlineBlockers drops a carried Resolved entry; a clear of an existing
\* record notes one (noteResolvedBlockerFile).
RecordVerb(set) ==
    /\ rec' = set
    /\ noted' = IF set # {} THEN FALSE ELSE IF rec # {} THEN TRUE ELSE noted
    /\ cleared' = IF set # {} THEN {} ELSE IF rec # {} THEN rec ELSE cleared

Write(new, shift, touched) ==
    LET l == IF shift THEN [f \in AllF |-> ln[f] + 1] ELSE ln
        obs == Observe(new, touched)
        ids == IdsOf(obs, l)
        newIds == IF Delta /\ hasBase THEN ids \ base ELSE ids
        deltaSet == {f \in obs : Id(f, obs, l) \in newIds}
        current == IF ClearOnCurrent THEN obs ELSE deltaSet
    IN /\ disk' = new /\ ln' = l
       /\ base' = ids /\ hasBase' = TRUE
       /\ obsF' = obs /\ wobs' = obs
       /\ RecordVerb(current)
       /\ toolClean' = (current = {})
       /\ dState' = IF Deferred THEN "flight" ELSE "idle"
       /\ claim' = FALSE

WriteStep ==
    /\ nW < Writes
    /\ \E new \in SUBSET AllF, shift \in BOOLEAN, touched \in SUBSET Fast :
        /\ ((new \ disk) \cup (disk \ new)) \cap Fast \subseteq touched
        /\ (shift => \A f \in AllF : ln[f] < MaxShift)
        /\ Write(new, shift, touched)
    /\ nW' = nW + 1
    /\ UNCHANGED <<claimSet, claimOk, nO, nT>>

\* An unauthored write that changes F's bytes but introduces no blocker. Its
\* run withholds the blocker channel: it never records. Before #4484 it
\* cleared on new bytes whatever it observed; after, only on an empty
\* observation.
OpaqueStep ==
    /\ nO < OpaqueWrites
    /\ \E new \in SUBSET disk :
        LET obs == Observe(new, (disk \ new) \cap Fast)
            clears == IF OpaqueKeep THEN obs = {} ELSE TRUE
        IN /\ disk' = new
           /\ base' = IdsOf(obs, ln) /\ hasBase' = TRUE
           /\ obsF' = obs
           /\ IF clears THEN RecordVerb({})
                        ELSE UNCHANGED <<rec, noted, cleared>>
           /\ dState' = IF Deferred THEN "flight" ELSE "idle"
    /\ nO' = nO + 1
    /\ claim' = FALSE
    /\ UNCHANGED <<ln, wobs, toolClean, claimSet, claimOk, nW, nT>>

\* The collect-later run of the current bytes settles; its blocker joins the
\* record (recordDeferredInlineBlockers merges and leaves the Resolved entry).
DoSettle ==
    /\ dState' = "settled"
    /\ rec' = IF "d" \in disk THEN rec \cup {"d"} ELSE rec

SettleStep ==
    /\ dState = "flight"
    /\ DoSettle
    /\ UNCHANGED <<disk, ln, base, hasBase, obsF, wobs, toolClean, noted,
                   cleared, claim, claimSet, claimOk, nW, nO, nT>>

ObservedGone(f, ds) ==
    /\ f \notin disk
    /\ (f \in Def => ds = "settled")

TurnEndStep ==
    /\ nT < Turns
    /\ \E settle \in BOOLEAN :
        LET ds == IF settle /\ dState = "flight" THEN "settled" ELSE dState
            r == IF settle /\ dState = "flight" /\ "d" \in disk THEN rec \cup {"d"} ELSE rec
            prints == noted /\ r = {}
        IN /\ dState' = ds /\ rec' = r
           /\ claim' = prints
           /\ claimSet' = IF prints THEN cleared ELSE {}
           /\ claimOk' = IF prints THEN \A f \in cleared : ObservedGone(f, ds) ELSE TRUE
           /\ noted' = IF prints THEN FALSE ELSE noted
           /\ cleared' = IF prints THEN {} ELSE cleared
    /\ nT' = nT + 1
    /\ UNCHANGED <<disk, ln, base, hasBase, obsF, wobs, toolClean, nW, nO>>

Next == WriteStep \/ OpaqueStep \/ SettleStep \/ TurnEndStep

Spec == Init /\ [][Next]_vars

\* The completed observations of the current bytes.
CurObs == obsF \cup (IF dState = "settled" /\ "d" \in disk THEN {"d"} ELSE {})

GateHonest == rec = {} => CurObs = {}
CleanHonest == toolClean => wobs = {}
ResolvedHonest == claim => claimOk
GateSound == rec = {} => disk \cap Fast = {}
=============================================================================
