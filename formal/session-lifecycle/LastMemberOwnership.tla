---------------------- MODULE LastMemberOwnership ----------------------
EXTENDS FiniteSets, TLC
\* #4554 r5: two activations, three context identities. M and R deliberately
\* have the SAME stable session id; only registration context identifies owner.
\* R may replace stale M in A, or reload into B after M leaves A with S live.
\* No timers, stores or filesystem protocol are abstracted by this slice.
\* #4554 r6 (Greptile F1): may a leave this activation cannot place run the
\* shared teardown? FALSE is as-built: last means no live member remains, so a
\* superseded primary's delayed shutdown cannot stop the replacement.
CONSTANT UnmatchedLeaveIsLast
\* #4704: pi 1.3.0 runs the factory once per session load, so an in-process
\* subagent T is its OWN activation C (a declined start: C admits nothing).
\* ProcessWideLast: is "last" read across every activation (TRUE, as-built),
\* or within the leaving one (FALSE, pre-fix: M's leave tore down under T)?
\* With TRUE, the process's last leave releases whichever registration is
\* held, whatever its activation admitted: no live successor can remain, and
\* no other leave would release it (S last in A after R left B, or T last).
\* StaleMemberHolds: does a member pi invalidated without a shutdown still
\* count as live? pi's `AgentSession.dispose()` emits no session_shutdown, so
\* TRUE strands the registration forever once T is disposed; FALSE is as-built
\* (`hasLiveSessionInProcess` skips a context `probeCtxActive` reads stale).
CONSTANTS ProcessWideLast, StaleMemberHolds

VARIABLES members, admitted, owner, started, cleaned, departed, saved, foreignTeardown,
          earlyTeardown, stale, missedTeardown
vars == <<members, admitted, owner, started, cleaned, departed, saved, foreignTeardown,
          earlyTeardown, stale, missedTeardown>>
Acts == {"A", "B", "C"}
Ctxs == {"M", "R", "S", "T"}
Role(c) == IF c \in {"S", "T"} THEN "secondary" ELSE "primary"
AllMembers(m) == UNION {m[a] : a \in Acts}
\* The truth: a session pi disposed never shuts down and is not live.
TrueLive(m) == {c \in AllMembers(m) : c \notin stale}
\* What the code counts as live.
CodeLive(m) == IF StaleMemberHolds THEN AllMembers(m) ELSE TrueLive(m)
Init == /\ members = [a \in Acts |-> {}]
        /\ admitted = [a \in Acts |-> "none"]
        /\ owner = "none" /\ started = {} /\ cleaned = {} /\ departed = {}
        /\ saved = [c \in Ctxs |-> "none"] /\ foreignTeardown = FALSE
        /\ earlyTeardown = FALSE /\ stale = {} /\ missedTeardown = FALSE
StartM == /\ "M" \notin started
          /\ members' = [members EXCEPT !["A"] = {"M"}]
          /\ admitted' = [admitted EXCEPT !["A"] = "M"]
          /\ owner' = "M" /\ started' = started \cup {"M"}
          /\ UNCHANGED <<cleaned, departed, saved, foreignTeardown, earlyTeardown, stale, missedTeardown>>
StartS == /\ "M" \in members["A"] /\ "S" \notin started
          /\ members' = [members EXCEPT !["A"] = @ \cup {"S"}]
          /\ started' = started \cup {"S"}
          /\ UNCHANGED <<admitted, owner, cleaned, departed, saved, foreignTeardown, earlyTeardown, stale, missedTeardown>>
\* #4704: M's subagent binds in its own activation C and is declined.
StartT == /\ "M" \in members["A"] /\ "T" \notin started
          /\ members' = [members EXCEPT !["C"] = @ \cup {"T"}]
          /\ started' = started \cup {"T"}
          /\ UNCHANGED <<admitted, owner, cleaned, departed, saved, foreignTeardown, earlyTeardown, stale, missedTeardown>>
\* #4704: T's runner disposes its session: pi invalidates T's contexts and
\* emits no session_shutdown, so T never leaves.
DisposeT == /\ "T" \in members["C"] /\ "T" \notin stale
            /\ stale' = stale \cup {"T"}
            /\ UNCHANGED <<members, admitted, owner, started, cleaned, departed, saved,
                           foreignTeardown, earlyTeardown, missedTeardown>>
StartR(a) == /\ a # "C" /\ "M" \in started /\ "R" \notin started
             /\ IF a = "B" THEN "M" \notin members["A"] ELSE TRUE
             /\ members' = [members EXCEPT ![a] =
                    {c \in @ : Role(c) # "primary"} \cup {"R"}]
             /\ admitted' = [admitted EXCEPT ![a] = "R"]
             /\ owner' = "R" /\ started' = started \cup {"R"}
             /\ UNCHANGED <<cleaned, departed, saved, foreignTeardown, earlyTeardown, stale, missedTeardown>>
Leave(a,c) ==
    /\ c \in members[a]
    /\ c \notin stale
    /\ LET remaining == members[a] \ {c}
           after == [members EXCEPT ![a] = remaining]
           last == IF ProcessWideLast THEN CodeLive(after) = {} ELSE remaining = {}
           owns == IF ProcessWideLast THEN owner # "none" ELSE admitted[a] = owner
           tearsDown == last /\ owns
       IN /\ members' = after
          /\ owner' = IF tearsDown THEN "none" ELSE owner
          \* #4704: released a registration whose own session is still live.
          /\ foreignTeardown' = (foreignTeardown \/
                    (tearsDown /\ owner \in TrueLive(after)))
          /\ earlyTeardown' = (earlyTeardown \/ (tearsDown /\ TrueLive(after) # {}))
          \* #4704: a leave that leaves no session truly live keeps a held
          \* registration (the stale-holds mutation: a disposed T kept it).
          /\ missedTeardown' = (missedTeardown \/
                    (~tearsDown /\ owner # "none" /\ TrueLive(after) = {}))
    /\ departed' = departed \cup {c}
    /\ cleaned' = cleaned \cup {c}
    /\ saved' = [saved EXCEPT ![c] = Role(c)]
    /\ UNCHANGED <<admitted, started, stale>>
\* #4554 r6: the superseded primary's DELAYED shutdown arrives after the
\* replacement's full admission retired its membership record in this
\* activation, so it is unmatched. It may run no shared teardown: a live member
\* remains and the owner registration is the replacement's, not the departing
\* context's. `UnmatchedLeaveIsLast = TRUE` is the pre-fix reading that reset a
\* live replacement's LSP fleet and registry entry (and retired its scope).
LateLeave(a, c) ==
    /\ c \in started
    /\ c \notin members[a]
    /\ owner = admitted[a]
    /\ members[a] # {}
    /\ LET tearsDown == UnmatchedLeaveIsLast
       IN /\ owner' = IF tearsDown THEN "none" ELSE owner
          /\ earlyTeardown' = (earlyTeardown \/ tearsDown)
    /\ UNCHANGED <<members, admitted, started, foreignTeardown, stale, missedTeardown>>
    /\ departed' = departed \cup {c}
    /\ cleaned' = cleaned \cup {c}
    /\ saved' = [saved EXCEPT ![c] = Role(c)]

Next == StartM \/ StartS \/ StartT \/ DisposeT \/ (\E a \in Acts : StartR(a)) \/
        (\E a \in Acts, c \in Ctxs : Leave(a,c)) \/
        (\E a \in Acts, c \in Ctxs : LateLeave(a,c))
Spec == Init /\ [][Next]_vars
NoForeignTeardown == ~foreignTeardown
NoEarlyTeardown == ~earlyTeardown
NoSupersededMembers == ~("R" \in started /\ admitted["A"] = "R" /\
    "M" \in members["A"])
\* #4704: the registration is held only while a session is truly live (the
\* #472 leak), with ONE accepted exception: every member still recorded was
\* disposed with no shutdown, so no pi-lens callback can run. That is T
\* disposed after M left first; the next full admission or process exit
\* releases it (the PR's accepted residual). Before #4704 this read "an
\* activation that admitted the owner still has a member", which the
\* cross-activation rule deliberately breaks while T outlives M.
NoStrandedOwner == owner = "none" \/ TrueLive(members) # {} \/
    (AllMembers(members) # {} /\ AllMembers(members) \subseteq stale)
NoMissedTeardown == ~missedTeardown
OwnScopeAndCleanup == departed \subseteq cleaned /\
    \A c \in departed : saved[c] = Role(c)
=============================================================================
