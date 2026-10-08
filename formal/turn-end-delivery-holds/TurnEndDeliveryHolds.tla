---------------------- MODULE TurnEndDeliveryHolds ----------------------
(***************************************************************************)
(* The turn-end composer's delivery holds (#3813): a producer that has   *)
(* consumed one-shot state for a part registers a hold on the part, and  *)
(* the composer settles every hold ONCE, after the cap, against what the *)
(* message actually kept (clients/turn-end/delivery-holds.ts,            *)
(* clients/runtime-turn.ts `handleTurnEnd`).                             *)
(*                                                                       *)
(* One part per item. The model has three hold shapes and six items:     *)
(*  - peek-then-commit (items 1 and 6): the producer leaves its state    *)
(*    alone at compose; `onDelivered` commits it. Item 1 is the          *)
(*    dependency-drift count (skipOnSuppressed, runtime-turn.ts:1574-1575);*)
(*    item 6 is the past-EOF retirement, which settles as delivered even *)
(*    on a suppressed turn (runtime-turn.ts:1567-1570);                  *)
(*  - drain-then-restore (items 2 and 3): the producer's state is drained*)
(*    at compose; `onHeld` puts it back. Item 2 is the late auxiliary    *)
(*    pair, bounded by `canHold` (runtime-turn.ts:5073). Item 3 stands for *)
(*    the unbounded restores: a settled runner result requeued           *)
(*    (runtime-turn.ts:1302, 1376) and a cascade run re-appended         *)
(*    (runtime-turn.ts:1877, 2040);                                      *)
(*  - park-then-recheck (items 4 and 5): the producer has no queue, so   *)
(*    `onHeld` parks the shown items on the coordinator under a lane key *)
(*    (runtime-turn.ts:1229-1240); the lane's next run takes them and    *)
(*    offers each once more, only while that run still reports it        *)
(*    (runtime-turn.ts:2257-2258, 2280). Item 4 belongs to the primary   *)
(*    session, item 5 to a concurrent secondary (subagent) activation that *)
(*    runs the same composer on the same process-singleton runtime       *)
(*    (runtime-turn.ts:1190-1202).                                       *)
(*                                                                       *)
(* Actions (one per step of handleTurnEnd, per session s):               *)
(*  - NextTurn(s): the park lane's run takes the entries under its key and *)
(*    rechecks stillReportedParked;                                      *)
(*  - Compose(s): the producers push parts (drain, requeue, restore, park) *)
(*    in any order; peek leaves state alone;                             *)
(*  - Cap(s): planDeliveryHolds + capTurnEndMessage: the reach rule, one *)
(*    canHold ask per part, and the signature-dedupe verdict;            *)
(*  - Settle(s): each hold runs once, guarded by isCurrentSession;       *)
(*  - SessionReplace: resetForSession clears the session-scoped stores.  *)
(*                                                                       *)
(* Cap and Settle are one synchronous block in the code (runtime-turn.ts:*)
(* 5285-5386, no await between them), so SessionReplace is disabled while*)
(* a session sits between them.                                          *)
(*                                                                       *)
(* Invariants:                                                           *)
(*  - NoLossByCap: a part the cap cut is still pending after Settle,     *)
(*    unless it was dropped with a recorded reason;                      *)
(*  - NoDoubleDelivery: an item reaches the agent at most once, and a    *)
(*    re-offer is shown only while its lane still reports it;            *)
(*  - NoPin: a re-offered item is never parked again, and a leading part *)
(*    is never held (it could not fit alone, so holding it pins it);     *)
(*  - HoldFencedToSession: a session's parts hold only its own items, and*)
(*    no store entry written by a replaced session survives.             *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    CapChars,    \* chars the cap keeps (RUNTIME_CONFIG.turnEnd.maxChars, one axis)
    Sep,         \* separator length (delivery-holds.ts:113, "\n\n")
    SizeSet,     \* the sizes a part can take
    MaxTurns,    \* Compose steps per session
    MaxGen,      \* the runtime generation bound
    RearmMax,    \* MAX_LATE_AUX_REARMS (pending-aux-coverage.ts:69, 211)
    PeekCommit,  \* "atCap"     commit at Settle, after the cap (shipped)
                 \* "atCompose" the producer commits when it composes (pre-#3813)
    DrainAsk,    \* "asked" the aux hold carries canHold (runtime-turn.ts:5073)
                 \* "never" no canHold: the cut part is promised, not kept
    ReOffer,     \* "once"      a part showing only re-offers cannot be held
                 \*             (runtime-turn.ts:1228, canHold = fresh.length > 0)
                 \* "unbounded" a re-offer is parked again
    ParkKey,     \* "session" the lane key carries the turn's session id
                 \*           (runtime-turn.ts:1199-1202, #4112 round 2)
                 \* "lane"    the pre-round-2 key: shared by every session
    Lead,        \* "leads" the leader is reached (delivery-holds.ts:105-106)
                 \* "none"  the leader is held like any other cut part
    Recheck,     \* "checked"   a parked item returns only while still reported
                 \*             (delivery-holds.ts:157-165)
                 \* "unchecked" every parked item returns
    Fence,       \* "checked"   Settle skips a replaced session (delivery-holds.ts:125, 130)
                 \* "unchecked" Settle runs against the new session's stores
    OnReached    \* "none" onHeld runs only for a cut part (shipped)
                 \* "restore" mutant: a drain hold also restores a reached part

VARIABLES
    gen,        \* the runtime's session generation (runtime-coordinator.ts:1264)
    st,         \* [Items -> status of the item's producer state]
    igen,       \* [Items -> generation that last wrote the item's store entry]
    parks,      \* [Items -> times the item was parked this generation]
    rearm,      \* [Items -> times the item was restored this generation]
    dcnt,       \* [Items -> times the agent received the item this generation]
    phase,      \* [Sess -> "idle" | "composed" | "capped"]
    turns,      \* [Sess -> Compose steps taken]
    offerQ,     \* [Sess -> items the lane run took and rechecked, to be offered]
    unrep,      \* items in offerQ whose lane no longer reports them
    plan,       \* [Sess -> the composed parts: <<[item, size, reoff]>>]
    verdict,    \* [Sess -> <<[reached, keeps]>>] from planDeliveryHolds
    supp,       \* [Sess -> the message is signature-suppressed]
    hgen,       \* [Sess -> holdGeneration, captured at the turn's start]
    lost,       \* a cut part left Settle neither pending nor recorded dropped
    leadHeld,   \* a leading part was held
    staleShown  \* a re-offer was shown after its lane stopped reporting it

vars == <<gen, st, igen, parks, rearm, dcnt, phase, turns, offerQ, unrep, plan,
          verdict, supp, hgen, lost, leadHeld, staleShown>>

Sess == 1..2
Items == 1..6
Parts(s) == DOMAIN plan[s]

\* Items 1 and 6 peek (6 is the secondary's), 2 aux pair, 3 runner/cascade,
\* 4 and 5 the park lanes of sessions 1 and 2.
Owner(i) == IF i \in {5, 6} THEN 2 ELSE 1
Shape(i) == IF i \in {1, 6} THEN "peek" ELSE IF i \in {2, 3} THEN "drain" ELSE "park"
SkipSupp(i) == i = 1
AuxItem == 2
ParkItems == {4, 5}
ParkOf(s) == IF s = 1 THEN 4 ELSE 5
KeyOf(i) == IF ParkKey = "session" THEN Owner(i) ELSE 0

\* st: "src" the producer will offer it (peek pending, drain queued, park new);
\*     "msg" in a composed message; "parked" in the coordinator's park map;
\*     "taken" taken from the map, to be offered; "done" delivered or committed;
\*     "fixed" the lane no longer reports it; "dropped" dropped with a record;
\*     "expired" re-armed past its bound, retired undelivered at the next
\*     drain; "evicted" replaced in the park map.
Statuses == {"src", "msg", "parked", "taken", "done", "fixed", "dropped",
             "expired", "evicted"}

TypeOK ==
    /\ gen \in 1..MaxGen
    /\ st \in [Items -> Statuses]
    /\ igen \in [Items -> 1..MaxGen]
    /\ parks \in [Items -> Nat]
    /\ rearm \in [Items -> Nat]
    /\ dcnt \in [Items -> Nat]
    /\ phase \in [Sess -> {"idle", "composed", "capped"}]
    /\ turns \in [Sess -> 0..MaxTurns]
    /\ offerQ \in [Sess -> SUBSET Items]
    /\ unrep \subseteq Items
    /\ supp \in [Sess -> BOOLEAN]
    /\ hgen \in [Sess -> 0..MaxGen]
    /\ lost \in BOOLEAN
    /\ leadHeld \in BOOLEAN
    /\ staleShown \in BOOLEAN

Init ==
    /\ gen = 1
    /\ st = [i \in Items |-> "src"]
    /\ igen = [i \in Items |-> 1]
    /\ parks = [i \in Items |-> 0]
    /\ rearm = [i \in Items |-> 0]
    /\ dcnt = [i \in Items |-> 0]
    /\ phase = [s \in Sess |-> "idle"]
    /\ turns = [s \in Sess |-> 0]
    /\ offerQ = [s \in Sess |-> {}]
    /\ unrep = {}
    /\ plan = [s \in Sess |-> <<>>]
    /\ verdict = [s \in Sess |-> <<>>]
    /\ supp = [s \in Sess |-> FALSE]
    /\ hgen = [s \in Sess |-> 0]
    /\ lost = FALSE
    /\ leadHeld = FALSE
    /\ staleShown = FALSE

Range(f) == {f[k] : k \in DOMAIN f}

(* NextTurn(s): the park lane's next successful run takes every entry under  *)
(* its key (runtime-coordinator.ts:1486-1490) and keeps the ones it still*)
(* reports (delivery-holds.ts:157-165, runtime-turn.ts:2280). A failed run   *)
(* leaves them parked, so the action is optional.                        *)
Taken(s) == {i \in ParkItems : st[i] = "parked" /\ KeyOf(i) = KeyOf(ParkOf(s))}

NextTurn(s) ==
    /\ phase[s] = "idle"
    /\ offerQ[s] = {}
    /\ Taken(s) # {}
    /\ \E rep \in [Taken(s) -> BOOLEAN] :
        LET reoff == {i \in Taken(s) : Recheck = "unchecked" \/ rep[i]}
            gone == Taken(s) \ reoff
        IN /\ st' = [i \in Items |->
                        IF i \in reoff THEN "taken"
                        ELSE IF i \in gone THEN "fixed" ELSE st[i]]
           /\ offerQ' = [offerQ EXCEPT ![s] = reoff]
           /\ unrep' = unrep \cup {i \in reoff : ~rep[i]}
    /\ UNCHANGED <<gen, igen, parks, rearm, dcnt, phase, turns, plan, verdict,
                   supp, hgen, lost, leadHeld, staleShown>>

(* Compose(s): each producer that has something pushes its part. The order   *)
(* is the producer's (any here); a peek producer leaves its state alone  *)
(* (runtime-turn.ts:1566-1576), a drain or park producer consumes it     *)
(* (runtime-turn.ts:1302, 2257-2258). Every taken re-offer must appear.  *)
Cands(s) == {i \in Items : Owner(i) = s /\ st[i] = "src"} \cup offerQ[s]

Compose(s) ==
    /\ phase[s] = "idle"
    /\ turns[s] < MaxTurns
    /\ Cands(s) # {}
    /\ \E n \in 1..3 : \E seq \in [1..n -> Cands(s)] : \E sz \in [1..n -> SizeSet] :
        /\ \A a, b \in 1..n : a # b => seq[a] # seq[b]
        /\ offerQ[s] \subseteq Range(seq)
        /\ plan' = [plan EXCEPT ![s] =
                [k \in 1..n |-> [item |-> seq[k], size |-> sz[k],
                                 reoff |-> seq[k] \in offerQ[s]]]]
        /\ st' = [i \in Items |->
                IF i \notin Range(seq) THEN st[i]
                ELSE IF Shape(i) = "peek"
                     THEN (IF PeekCommit = "atCompose" THEN "done" ELSE st[i])
                     ELSE "msg"]
        /\ staleShown' = (staleShown \/ (Range(seq) \cap unrep # {}))
        /\ unrep' = unrep \ Range(seq)
    /\ offerQ' = [offerQ EXCEPT ![s] = {}]
    /\ hgen' = [hgen EXCEPT ![s] = gen]
    /\ turns' = [turns EXCEPT ![s] = turns[s] + 1]
    /\ phase' = [phase EXCEPT ![s] = "composed"]
    /\ UNCHANGED <<gen, igen, parks, rearm, dcnt, verdict, supp, lost, leadHeld>>

(* Cap(s): planDeliveryHolds judges each part against the kept prefix    *)
(* (delivery-holds.ts:100-111). A part is reached when it lies whole inside  *)
(* the prefix, or leads (start 0) and so could not fit alone. `keeps` asks   *)
(* canHold once, before the message is final (delivery-holds.ts:110).    *)
RECURSIVE StartOf(_, _)
StartOf(pl, k) == IF k = 1 THEN 0 ELSE StartOf(pl, k - 1) + pl[k - 1].size + Sep

Reached(pl, k) ==
    \/ StartOf(pl, k) + pl[k].size <= CapChars
    \/ (Lead = "leads" /\ k = 1)

CanHold(item, reoff) ==
    CASE Shape(item) = "peek" -> TRUE
      [] Shape(item) = "drain" ->
            IF item = AuxItem /\ DrainAsk = "asked"
            THEN rearm[item] < RearmMax ELSE TRUE
      [] OTHER -> IF ReOffer = "once" THEN ~reoff ELSE TRUE

Cap(s) ==
    /\ phase[s] = "composed"
    /\ \E sp \in BOOLEAN :
        /\ supp' = [supp EXCEPT ![s] = sp]
        /\ verdict' = [verdict EXCEPT ![s] =
                [k \in Parts(s) |->
                    [reached |-> Reached(plan[s], k),
                     keeps |-> Reached(plan[s], k)
                               \/ CanHold(plan[s][k].item, plan[s][k].reoff)]]]
    /\ phase' = [phase EXCEPT ![s] = "capped"]
    /\ UNCHANGED <<gen, st, igen, parks, rearm, dcnt, turns, offerQ, unrep,
                   plan, hgen, lost, leadHeld, staleShown>>

(* Settle(s): every hold runs once (delivery-holds.ts:120-146). A session*)
(* replaced mid-turn owns none of this state, so the callbacks are skipped   *)
(* (delivery-holds.ts:125, 130, runtime-turn.ts:5294).                   *)
ItemAt(s, k) == plan[s][k].item
Reach(s, k) == verdict[s][k].reached
Keeps(s, k) == verdict[s][k].keeps
Held(s, k) == ~Reach(s, k) /\ Keeps(s, k)
PartOf(s, i) == CHOOSE k \in Parts(s) : ItemAt(s, k) = i

\* A later part parks under the same lane key: a park REPLACES its lane's
\* entry (runtime-coordinator.ts:1479-1481).
Replaced(s, k) ==
    \E k2 \in Parts(s) :
        /\ k2 > k
        /\ Shape(ItemAt(s, k2)) = "park"
        /\ Held(s, k2)
        /\ KeyOf(ItemAt(s, k2)) = KeyOf(ItemAt(s, k))

PartSt(s, k) ==
    LET i == ItemAt(s, k) IN
    IF Reach(s, k)
    THEN IF supp[s] /\ SkipSupp(i) THEN st[i]
         ELSE IF OnReached = "restore" /\ Shape(i) = "drain" THEN "src"
         ELSE "done"
    ELSE IF Keeps(s, k)
    THEN CASE Shape(i) = "peek" -> st[i]
           [] Shape(i) = "drain" ->
                 IF i = AuxItem /\ rearm[i] >= RearmMax THEN "expired" ELSE "src"
           [] OTHER -> IF Replaced(s, k) THEN "evicted" ELSE "parked"
    ELSE "dropped"

\* The part's callback wrote a store entry (restore or park).
WritesStore(s, k) ==
    LET i == ItemAt(s, k) IN
    \/ Held(s, k) /\ Shape(i) # "peek"
    \/ Reach(s, k) /\ OnReached = "restore" /\ Shape(i) = "drain"

Settle(s) ==
    /\ phase[s] = "capped"
    /\ LET trueLive == hgen[s] = gen
           run == trueLive \/ Fence = "unchecked"
           inPlan(i) == \E k \in Parts(s) : ItemAt(s, k) = i
           parksNow == {k \in Parts(s) : Held(s, k) /\ Shape(ItemAt(s, k)) = "park"}
           newSt == [i \in Items |->
                IF ~run THEN st[i]
                ELSE IF inPlan(i) THEN PartSt(s, PartOf(s, i))
                \* A park by another item replaces this lane's entry.
                ELSE IF st[i] = "parked"
                        /\ \E k \in parksNow : KeyOf(ItemAt(s, k)) = KeyOf(i)
                     THEN "evicted"
                ELSE st[i]]
       IN /\ st' = newSt
          /\ igen' = [i \in Items |->
                IF run /\ inPlan(i) /\ WritesStore(s, PartOf(s, i))
                THEN hgen[s] ELSE igen[i]]
          /\ parks' = [i \in Items |->
                IF run /\ inPlan(i) /\ PartOf(s, i) \in parksNow
                THEN parks[i] + 1 ELSE parks[i]]
          /\ rearm' = [i \in Items |->
                IF run /\ inPlan(i) /\ i = AuxItem /\ newSt[i] = "src"
                   /\ WritesStore(s, PartOf(s, i))
                THEN rearm[i] + 1 ELSE rearm[i]]
          /\ dcnt' = [i \in Items |->
                IF trueLive /\ inPlan(i) /\ Reach(s, PartOf(s, i)) /\ ~supp[s]
                THEN dcnt[i] + 1 ELSE dcnt[i]]
          /\ lost' = (lost \/ (trueLive /\
                (\/ \E k \in Parts(s) :
                      /\ ~Reach(s, k)
                      /\ newSt[ItemAt(s, k)] \notin {"src", "parked", "dropped"}
                 \/ \E j \in Items : st[j] = "parked" /\ newSt[j] = "evicted")))
          /\ leadHeld' = (leadHeld \/ (Len(plan[s]) >= 1 /\ ~Reach(s, 1)))
    /\ plan' = [plan EXCEPT ![s] = <<>>]
    /\ verdict' = [verdict EXCEPT ![s] = <<>>]
    /\ phase' = [phase EXCEPT ![s] = "idle"]
    /\ UNCHANGED <<gen, turns, offerQ, unrep, supp, hgen, staleShown>>

(* SessionReplace: resetForSession retires the scope and clears the      *)
(* session-scoped stores: the park map (runtime-coordinator.ts:667), the *)
(* cascade runs, the pending runner store (cleared at session_start). The*)
(* new session's producers start fresh.                                  *)
SessionReplace ==
    /\ gen < MaxGen
    /\ \A s \in Sess : phase[s] # "capped"
    /\ gen' = gen + 1
    /\ st' = [i \in Items |-> "src"]
    /\ igen' = [i \in Items |-> gen + 1]
    /\ parks' = [i \in Items |-> 0]
    /\ rearm' = [i \in Items |-> 0]
    /\ dcnt' = [i \in Items |-> 0]
    /\ offerQ' = [s \in Sess |-> {}]
    /\ unrep' = {}
    /\ UNCHANGED <<phase, turns, plan, verdict, supp, hgen, lost, leadHeld,
                   staleShown>>

Next ==
    \/ SessionReplace
    \/ \E s \in Sess : NextTurn(s) \/ Compose(s) \/ Cap(s) \/ Settle(s)

Spec == Init /\ [][Next]_vars

(* NoLossByCap: Settle never leaves a cut part gone with no record.      *)
NoLossByCap == ~lost

(* NoDoubleDelivery: delivery-holds.ts:157-165 offers a parked item once, and *)
(* only while still reported; an item reaches the agent once.            *)
NoDoubleDelivery == (\A i \in Items : dcnt[i] <= 1) /\ ~staleShown

(* NoPin: a re-offer is not parked again (delivery-holds.ts:25-26), and the  *)
(* leader is reached, since holding it would pin it (delivery-holds.ts:28-33). *)
NoPin == (\A i \in Items : parks[i] <= 1) /\ ~leadHeld

(* HoldFencedToSession: a turn composes only its own session's items, and no *)
(* store entry carries a replaced session's generation.                  *)
HoldFencedToSession ==
    /\ \A s \in Sess : \A k \in Parts(s) : Owner(plan[s][k].item) = s
    /\ \A i \in Items : st[i] \in {"src", "parked"} => igen[i] = gen

=========================================================================
