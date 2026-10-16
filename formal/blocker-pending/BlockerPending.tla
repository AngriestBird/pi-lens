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
 - RangeGated: finding "a" comes from a runner whose edit-range gate
   withholds blocking matches on lines the write did not change (tree-sitter,
   the ast-grep runners; `spanOverlapsModifiedRanges`). The delivered
   observation then does not show "a" on an untouched line;
 - MayFail: a fast run, an unauthored run or a settling collect-later run may
   reach no verdict (a timeout, a server error, an unanswered wait). Its
   findings are absent and it shows nothing gone;
 - Unused: finding "u" is an unused value. It blocks only while the delta
   calls it new (dispatcher.ts `promoteDeltaUnusedToBlockers`); held back as
   already seen it is still observed, as a warning.

The round-2 fix switches (#4484 round 2, each pinned TRUE). A recorded
blocker leaves the record only when a conclusive observation from its own
source shows it gone. FALSE is the round-1 code, where the record was the
delivered blocking set:
 - ScopeDeliveryOnly: an edit-range gate decides delivery only. A recorded
   blocker the gate withheld stays in the record (`outOfEditScope`,
   `DispatchResult.stillObserved`); one never recorded does not enter it;
 - CarryInconclusive: a recorded blocker whose runner reached no verdict on
   the write stays (`reachedNoVerdict`, `DispatchResult.inconclusiveSources`);
 - CarryDeferred: a recorded collect-later blocker stays while its re-check is
   in flight, and a settled conclusive run of the current bytes that no
   longer observes it retires it (`retireUnobservedRunnerBlockers`), noting
   F Resolved when the record empties;
 - CarryPromoted: a recorded promoted unused value stays while the run still
   observes it, held back as already seen.

The round-3 environment and fix switches (#4484 round 3; PR #4491's state
table, rules R1 to R4). Each fix switch is pinned TRUE:
 - Twin (environment): finding "p" is a second occurrence of "a"'s rule with
   "a"'s identity, already in F's bytes at the start and never delivered
   unless a write changes its line. It is range-gated like "a";
 - MaySkip (environment): a fast run may skip without reading the bytes (a
   size or line cap, an aborted WASM runtime, an unavailable grammar or
   server);
 - CarryByPosition (R2, R3): a recorded blocker is kept by an observation of
   its identity at its own aligned line only. FALSE is the round-2 code: the
   carry matched by identity alone and kept the observed copy, so a withheld
   "p" stood in for a fixed "a" (retainRecordedFindings);
 - SkipNoVerdict (R1): a skip without a stated not-applicable reason reaches
   no verdict (`reachedNoVerdict`). FALSE is the round-2 code: such a skip
   was a conclusive, empty observation;
 - OwedRanges (R4): the lines a write with no verdict covered stay owed, and
   they join the next run's range (`DispatchContext.owedRanges`). FALSE is
   the round-2 code: the next run withheld a blocker first written then.

The round-4 environment and fix switches (#4484 round 4; PR #4491's round-4
state table). The fix switch is pinned TRUE:
 - MayUnalign (environment): a write may have no line alignment to the
   bytes the record is about (an edit past the 1000-edit cap, a record with
   no anchor, bytes past the 2 MiB or 100000-line caps). It matters only
   when lines moved (`shift`): otherwise a recorded line is still right;
 - UnalignedIdentity (round 4): with no alignment a recorded blocker matches
   its identity anywhere, so a withheld "a" stays and a withheld "p" may
   stand in for a fixed "a" (a false block; the record keeps the observed
   copy). FALSE is the round-3 code: it read the recorded line number as it
   was, found nothing there, and retired a withheld "a" still in the bytes
   (verify probes P11c, P11d, P18).

Invariants:
 - GateHonest: the commit gate is open only when no completed observation of
   the current bytes holds a blocker;
 - CleanHonest: a write's tool result says clean only when its observation
   holds no blocker;
 - ResolvedHonest: F is reported resolved only when the run that cleared
   the record observed every blocker it held gone (the ghost `clearOk`): a
   conclusive inline run of bytes without the inline ones, and a settled
   conclusive collect-later run of the current bytes without d. A write
   never observes d (its re-check is in flight), so a write that clears a
   recorded d is never honest about it;
 - GateSound: the gate is open only when the bytes hold no fast blocker
   outside the lines a run with no verdict still owes (the variable `owe`):
   stronger than GateHonest, it also catches a blocker a runner withholds or
   misreads. With MayFail and MaySkip FALSE nothing is ever owed;
 - RecordedReported: the record holds only findings some run delivered (the
   ghost `reported`): no observation stands in for a recorded blocker, except
   one a write with no alignment matched by identity (the ghost `held`, the
   fail-closed cost);
 - UnalignedKept: a write with no alignment never retires a recorded blocker
   its bytes still hold (the ghost `lost`);
 - RecordedKept: every blocker a run delivered stays in the record until a
   conclusive observation from its own source shows it gone (the ghost
   `owed`). It is the GateSound of a run that can fail or a value that blocks
   only when new: no write can block on a finding no run reported, so the
   property is about what was reported;
 - CleanSound: a write's tool result says clean only when nothing reported
   was still owed when it said so (the ghost `cleanOk`).
***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Writes,         \* authored writes of F
    OpaqueWrites,   \* unauthored (opaque recovery) writes of F
    Turns,          \* turn ends
    MaxShift,       \* line insertions above the findings
    Ordinal,        \* TRUE: ids are ordinal ranks (helm-lint); FALSE: line-bound (LSP)
    Deferred,       \* TRUE: the collect-later finding "d" exists
    RangeGated,     \* TRUE: "a" is delivered only on a line the write changed
    MayFail,        \* TRUE: a run may reach no verdict
    Unused,         \* TRUE: the unused value "u" exists
    Delta,          \* FALSE: --no-delta
    ClearOnCurrent, \* the #4484 fix: record/clean/clear read the current blocking set
    OpaqueKeep,     \* the #4484 fix, part 2: an unauthored run that still observes a blocker keeps the record
    ScopeDeliveryOnly, \* round 2: a range gate decides delivery only
    CarryInconclusive, \* round 2: a no-verdict run keeps its recorded blockers
    CarryDeferred,     \* round 2: an in-flight re-check keeps d; only a settled run retires it
    CarryPromoted,     \* round 2: a recorded promoted unused value stays while observed
    Twin,              \* round 3: "p", a pre-existing second occurrence of "a"'s rule
    MaySkip,           \* round 3: a fast run may skip without reading the bytes
    CarryByPosition,   \* round 3 (R2, R3): keep a recorded blocker only at its own line
    SkipNoVerdict,     \* round 3 (R1): a skip without a stated reason has no verdict
    OwedRanges,        \* round 3 (R4): a no-verdict write's lines join the next range
    MayUnalign,        \* round 4: a write may have no line alignment
    UnalignedIdentity  \* round 4: with no alignment, match a recorded blocker by identity

Fast == {"a", "b"}
U == IF Unused THEN {"u"} ELSE {}
Def == IF Deferred THEN {"d"} ELSE {}
Tw == IF Twin THEN {"p"} ELSE {}
\* The findings on lines a write may change (the fast runners' findings).
Lined == Fast \cup Tw
Inline == Lined \cup U
AllF == Inline \cup Def
\* The range-gated findings: "a" and its twin "p".
Gated == IF RangeGated THEN {"a"} \cup Tw ELSE {}
\* A fast run's outcomes: a verdict, a failure, a skip that read nothing.
Outcomes == {"ok"} \cup (IF MayFail THEN {"fail"} ELSE {})
                   \cup (IF MaySkip THEN {"skip"} ELSE {})

\* The id the delta keys on, for finding f in observation obs at line offsets l.
\* "u" is an LSP finding, so its id is line-bound whatever Ordinal says.
Id(f, obs, l) ==
    IF Ordinal /\ f \in Fast
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
    clearOk,    \* ghost: the noted clear's own run showed every finding it retired gone
    claim,      \* the latest turn end printed Resolved for F
    claimSet,   \* the findings that Resolved line claimed gone
    claimOk,    \* each claimed finding was observed gone when the line printed
    owed,       \* ghost: blockers a run delivered that no conclusive run has shown gone
    cleanOk,    \* ghost: when the latest write said clean, nothing was owed
    owe,        \* the lines (their findings) a run with no verdict covered, still owed
    reported,   \* ghost: every finding some run delivered
    lost,       \* ghost: recorded blockers still in the bytes a write with no alignment retired
    held,       \* ghost: findings a write with no alignment kept by identity, undelivered
    nW, nO, nT

vars == <<disk, ln, base, hasBase, rec, obsF, wobs, dState, toolClean, noted,
          cleared, clearOk, claim, claimSet, claimOk, owed, cleanOk, owe,
          reported, lost, held, nW, nO, nT>>

TypeOK ==
    /\ disk \subseteq AllF /\ rec \subseteq AllF /\ obsF \subseteq Inline
    /\ owed \subseteq AllF /\ owe \subseteq Lined /\ reported \subseteq AllF
    /\ lost \subseteq AllF /\ held \subseteq AllF
    /\ dState \in {"idle", "flight", "settled", "failed"}

Init ==
    /\ disk = Tw /\ ln = [f \in AllF |-> 0]
    /\ base = {} /\ hasBase = FALSE
    /\ rec = {} /\ obsF = {} /\ wobs = {}
    /\ dState = "idle" /\ toolClean = TRUE
    /\ noted = FALSE /\ cleared = {} /\ clearOk = TRUE
    /\ claim = FALSE /\ claimSet = {} /\ claimOk = TRUE
    /\ owed = {} /\ cleanOk = TRUE
    /\ owe = {} /\ reported = {}
    /\ lost = {} /\ held = {}
    /\ nW = 0 /\ nO = 0 /\ nT = 0

\* What the fast runners deliver as blocking for bytes `new` when the write
\* changed `touched`: the edit-range gate withholds "a" and "p" on an
\* untouched line.
Observe(new, touched) == {f \in new \cap Lined : f \notin Gated \/ f \in touched}

\* One inline run of bytes `new` (fail: it reached no verdict). A skip that
\* read nothing runs on `{}` (`Seen`): without SkipNoVerdict it is then a
\* conclusive, empty observation; with it, it is a failure.
Failed(o) == o = "fail" \/ (o = "skip" /\ SkipNoVerdict)
Seen(new, o) == IF o = "skip" THEN {} ELSE new
Full(new, fail) == IF fail THEN {} ELSE new \cap Lined
Deliv(new, touched, fail) == IF fail THEN {} ELSE Observe(new, touched)
USeen(new, fail) == IF fail THEN {} ELSE new \cap U
\* The unused values the delta calls new, promoted to blockers.
UBlock(new, fail, l) ==
    IF Delta /\ hasBase
      THEN {f \in USeen(new, fail) : Id(f, {}, l) \notin base}
      ELSE {}
\* The recorded blockers the run keeps although it did not deliver them.
\* `blind`: the write has no alignment and lines moved. Without
\* CarryByPosition the carry matches by identity alone: a withheld "p"
\* keeps a fixed, recorded "a" as its own observed copy. With it, a blind
\* write matches by identity too under UnalignedIdentity; without that, it
\* reads the stale line, finds nothing, and keeps no withheld blocker.
ByIdentity(blind) == ~CarryByPosition \/ (blind /\ UnalignedIdentity)
Positional(blind) == ~(CarryByPosition /\ blind /\ ~UnalignedIdentity)
StandIn(new, touched, fail, blind) ==
    IF Twin /\ ByIdentity(blind) /\ ScopeDeliveryOnly /\ "a" \in rec
       /\ "a" \notin Full(new, fail)
       /\ "p" \in Full(new, fail) \ Deliv(new, touched, fail)
      THEN {"p"} ELSE {}
Carried(new, touched, fail, l, blind) ==
    (IF ScopeDeliveryOnly /\ Positional(blind)
       THEN rec \cap (Full(new, fail) \ Deliv(new, touched, fail)) ELSE {})
    \cup StandIn(new, touched, fail, blind)
    \cup (IF CarryPromoted
       THEN rec \cap (USeen(new, fail) \ UBlock(new, fail, l)) ELSE {})
    \cup (IF CarryInconclusive /\ fail THEN rec \cap Inline ELSE {})
    \cup (IF CarryDeferred THEN rec \cap Def ELSE {})
\* The findings an inline run shows gone: none when it reached no verdict,
\* and never d, whose re-check every write leaves in flight.
Gone(new, fail) == IF fail THEN {} ELSE Inline \ new

\* What a conclusive inline run leaves owed: a finding it still observes,
\* delivered or not; a failed run shows nothing gone. d's re-check is in
\* flight on every write, so d stays owed.
OwedAfter(new, fail) ==
    IF fail THEN owed
    ELSE (owed \cap (Full(new, fail) \cup USeen(new, fail))) \cup (owed \cap Def)

\* The record verb after one dispatch: record `set`, or clear when it is empty.
\* recordInlineBlockers drops a carried Resolved entry; a clear of an existing
\* record notes one (noteResolvedBlockerFile).
RecordVerb(set, gone) ==
    /\ rec' = set
    /\ noted' = IF set # {} THEN FALSE ELSE IF rec # {} THEN TRUE ELSE noted
    /\ cleared' = IF set # {} THEN {} ELSE IF rec # {} THEN rec ELSE cleared
    /\ clearOk' = IF set # {} THEN TRUE
                  ELSE IF rec # {} THEN rec \subseteq gone ELSE clearOk

\* The lines a run covers: the write's own, and under OwedRanges the lines a
\* run with no verdict still owes. A run with no verdict leaves all of them
\* owed; an authored verdict discharges them.
Covers(touched) == touched \cup (IF OwedRanges THEN owe ELSE {})

Write(bytes, shift, edited, o, al) ==
    LET new == Seen(bytes, o)
        blind == ~al /\ shift
        fail == Failed(o)
        touched == Covers(edited)
        l == IF shift THEN [f \in AllF |-> ln[f] + 1] ELSE ln
        obs == Deliv(new, touched, fail)
        ub == UBlock(new, fail, l)
        ids == IdsOf(obs, l) \cup IdsOf(USeen(new, fail), l)
        newIds == IF Delta /\ hasBase THEN ids \ base ELSE ids
        deltaSet == {f \in obs : Id(f, obs, l) \in newIds}
        delivered == IF ClearOnCurrent THEN obs \cup ub ELSE deltaSet \cup ub
        current == delivered \cup Carried(new, touched, fail, l, blind)
    IN /\ disk' = bytes /\ ln' = l
       /\ base' = ids /\ hasBase' = TRUE
       /\ obsF' = obs \cup ub /\ wobs' = obs \cup ub
       /\ RecordVerb(current, Gone(new, fail))
       /\ toolClean' = (current = {})
       /\ owed' = OwedAfter(new, fail) \cup delivered
       /\ cleanOk' = (current = {} => OwedAfter(new, fail) \cup delivered = {})
       /\ owe' = IF fail THEN owe \cup touched ELSE {}
       /\ reported' = reported \cup delivered
       /\ lost' = IF blind THEN (rec \ current) \cap bytes \cap Lined ELSE {}
       /\ held' = held \cup (IF blind
                    THEN StandIn(new, touched, fail, blind) \ delivered ELSE {})
       /\ dState' = IF Deferred THEN "flight" ELSE "idle"
       /\ claim' = FALSE

WriteStep ==
    /\ nW < Writes
    /\ \E new \in SUBSET AllF, shift \in BOOLEAN, touched \in SUBSET Lined,
          o \in Outcomes, al \in (IF MayUnalign THEN BOOLEAN ELSE {TRUE}) :
        /\ ((new \ disk) \cup (disk \ new)) \cap Lined \subseteq touched
        /\ (shift => \A f \in AllF : ln[f] < MaxShift)
        /\ Write(new, shift, touched, o, al)
    /\ nW' = nW + 1
    /\ UNCHANGED <<claimSet, claimOk, nO, nT>>

\* An unauthored write that changes F's bytes but introduces no blocker. Its
\* run withholds the blocker channel: it never records. Before #4484 it
\* cleared on new bytes whatever it observed; after, only on an empty
\* observation. It delivers nothing, so it discharges no owed line.
OpaqueStep ==
    /\ nO < OpaqueWrites
    /\ \E bytes \in SUBSET disk, o \in Outcomes :
        LET new == Seen(bytes, o)
            fail == Failed(o)
            touched == Covers((disk \ bytes) \cap Lined)
            obs == Deliv(new, touched, fail)
            ub == UBlock(new, fail, ln)
            keep == obs \cup ub \cup Carried(new, touched, fail, ln, FALSE)
            clears == IF OpaqueKeep THEN keep = {} ELSE TRUE
        IN /\ disk' = bytes
           /\ base' = IdsOf(obs, ln) \cup IdsOf(USeen(new, fail), ln)
           /\ hasBase' = TRUE
           /\ obsF' = obs \cup ub
           /\ IF clears THEN RecordVerb({}, Gone(new, fail))
                        ELSE UNCHANGED <<rec, noted, cleared, clearOk>>
           /\ owed' = OwedAfter(new, fail)
           /\ owe' = IF fail THEN owe \cup touched ELSE owe
           /\ dState' = IF Deferred THEN "flight" ELSE "idle"
    /\ nO' = nO + 1
    /\ claim' = FALSE
    /\ UNCHANGED <<ln, wobs, toolClean, claimSet, claimOk, cleanOk, reported,
                   lost, held, nW, nT>>

\* The collect-later run of the current bytes settles. A conclusive run's
\* blocker joins the record (recordDeferredInlineBlockers merges and leaves
\* the Resolved entry); under CarryDeferred, a conclusive run that no longer
\* observes d retires it, and an emptied record notes F Resolved
\* (retireUnobservedRunnerBlockers). A run that reached no verdict changes
\* nothing.
SettledRec(ok) ==
    IF ~ok THEN rec
    ELSE IF "d" \in disk THEN rec \cup {"d"}
    ELSE IF CarryDeferred THEN rec \ {"d"}
    ELSE rec
SettledOwed(ok) ==
    IF ~ok THEN owed
    ELSE IF "d" \in disk THEN owed \cup {"d"} ELSE owed \ {"d"}
\* The settle's retire empties the record: F is noted Resolved with what it held.
Retires(ok) == rec # {} /\ SettledRec(ok) = {}

SettleStep ==
    /\ dState = "flight"
    /\ \E ok \in (IF MayFail THEN BOOLEAN ELSE {TRUE}) :
        /\ dState' = IF ok THEN "settled" ELSE "failed"
        /\ rec' = SettledRec(ok)
        /\ owed' = SettledOwed(ok)
        /\ noted' = (noted \/ Retires(ok))
        /\ cleared' = IF Retires(ok) THEN rec ELSE cleared
        /\ clearOk' = IF Retires(ok) THEN TRUE ELSE clearOk
        /\ reported' = reported \cup (SettledRec(ok) \ rec)
    /\ UNCHANGED <<disk, ln, base, hasBase, obsF, wobs, toolClean,
                   claim, claimSet, claimOk, cleanOk, owe, lost, held,
                   nW, nO, nT>>

TurnEndStep ==
    /\ nT < Turns
    /\ \E settle \in BOOLEAN, ok \in (IF MayFail THEN BOOLEAN ELSE {TRUE}) :
        LET settles == settle /\ dState = "flight"
            ds == IF settles THEN (IF ok THEN "settled" ELSE "failed") ELSE dState
            r == IF settles THEN SettledRec(ok) ELSE rec
            nt == noted \/ (settles /\ Retires(ok))
            cl == IF settles /\ Retires(ok) THEN rec ELSE cleared
            ck == IF settles /\ Retires(ok) THEN TRUE ELSE clearOk
            prints == nt /\ r = {}
        IN /\ dState' = ds /\ rec' = r
           /\ owed' = IF settles THEN SettledOwed(ok) ELSE owed
           /\ claim' = prints
           /\ claimSet' = IF prints THEN cl ELSE {}
           /\ claimOk' = IF prints THEN ck ELSE TRUE
           /\ noted' = IF prints THEN FALSE ELSE nt
           /\ cleared' = IF prints THEN {} ELSE cl
           /\ clearOk' = IF prints THEN TRUE ELSE ck
           /\ reported' = reported \cup (r \ rec)
    /\ nT' = nT + 1
    /\ UNCHANGED <<disk, ln, base, hasBase, obsF, wobs, toolClean, cleanOk,
                   owe, lost, held, nW, nO>>

Next == WriteStep \/ OpaqueStep \/ SettleStep \/ TurnEndStep

Spec == Init /\ [][Next]_vars

\* The completed observations of the current bytes.
CurObs == obsF \cup (IF dState = "settled" /\ "d" \in disk THEN {"d"} ELSE {})

GateHonest == rec = {} => CurObs = {}
CleanHonest == toolClean => wobs = {}
ResolvedHonest == claim => claimOk
GateSound == rec = {} => disk \cap Fast \subseteq owe
RecordedKept == owed \subseteq rec
RecordedReported == rec \subseteq reported \cup held
UnalignedKept == lost = {}
CleanSound == cleanOk
=============================================================================
