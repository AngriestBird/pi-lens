---------------------- MODULE LastMemberOwnership ----------------------
EXTENDS FiniteSets, TLC
\* #4554 r5: two activations, three context identities. M and R deliberately
\* have the SAME stable session id; only registration context identifies owner.
\* R may replace stale M in A, or reload into B after M leaves A with S live.
\* No timers, stores or filesystem protocol are abstracted by this slice.
VARIABLES members, admitted, owner, started, cleaned, departed, saved, foreignTeardown
vars == <<members, admitted, owner, started, cleaned, departed, saved, foreignTeardown>>
Acts == {"A", "B"}
Ctxs == {"M", "R", "S"}
Role(c) == IF c = "S" THEN "secondary" ELSE "primary"
Init == /\ members = [a \in Acts |-> {}]
        /\ admitted = [a \in Acts |-> "none"]
        /\ owner = "none" /\ started = {} /\ cleaned = {} /\ departed = {}
        /\ saved = [c \in Ctxs |-> "none"] /\ foreignTeardown = FALSE
StartM == /\ "M" \notin started
          /\ members' = [members EXCEPT !["A"] = {"M"}]
          /\ admitted' = [admitted EXCEPT !["A"] = "M"]
          /\ owner' = "M" /\ started' = started \cup {"M"}
          /\ UNCHANGED <<cleaned, departed, saved, foreignTeardown>>
StartS == /\ "M" \in members["A"] /\ "S" \notin started
          /\ members' = [members EXCEPT !["A"] = @ \cup {"S"}]
          /\ started' = started \cup {"S"}
          /\ UNCHANGED <<admitted, owner, cleaned, departed, saved, foreignTeardown>>
StartR(a) == /\ "M" \in started /\ "R" \notin started
             /\ IF a = "B" THEN "M" \notin members["A"] ELSE TRUE
             /\ members' = [members EXCEPT ![a] =
                    {c \in @ : Role(c) # "primary"} \cup {"R"}]
             /\ admitted' = [admitted EXCEPT ![a] = "R"]
             /\ owner' = "R" /\ started' = started \cup {"R"}
             /\ UNCHANGED <<cleaned, departed, saved, foreignTeardown>>
Leave(a,c) ==
    /\ c \in members[a]
    /\ LET remaining == members[a] \ {c}
           tearsDown == remaining = {} /\ admitted[a] = owner
       IN /\ members' = [members EXCEPT ![a] = remaining]
          /\ owner' = IF tearsDown THEN "none" ELSE owner
          /\ foreignTeardown' = (foreignTeardown \/
                    (tearsDown /\ owner # admitted[a]))
    /\ departed' = departed \cup {c}
    /\ cleaned' = cleaned \cup {c}
    /\ saved' = [saved EXCEPT ![c] = Role(c)]
    /\ UNCHANGED <<admitted, started>>
Next == StartM \/ StartS \/ (\E a \in Acts : StartR(a)) \/
        (\E a \in Acts, c \in Ctxs : Leave(a,c))
Spec == Init /\ [][Next]_vars
NoForeignTeardown == ~foreignTeardown
NoSupersededMembers == ~("R" \in started /\ admitted["A"] = "R" /\
    "M" \in members["A"])
NoStrandedOwner == owner = "none" \/
    \E a \in Acts : admitted[a] = owner /\ members[a] # {}
OwnScopeAndCleanup == departed \subseteq cleaned /\
    \A c \in departed : saved[c] = Role(c)
=============================================================================
