------------------------- MODULE GrammarRetirement -------------------------
(******************************************************************************)
(* Small per-language projection of TreeSitterClient's grammar trap latch.   *)
(* A healed input is removed from the language set before the next input is  *)
(* considered.  This is the #4010 N2/F4 contract.                            *)
(******************************************************************************)
CONSTANT Language, InputA, InputB, LatchThreshold, Decay

VARIABLES phase, grammarTrapInputs, retired
vars == <<phase, grammarTrapInputs, retired>>

Init ==
    /\ phase = "trap-a"
    /\ grammarTrapInputs = {}
    /\ retired = FALSE

TrapA ==
    /\ phase = "trap-a"
    /\ grammarTrapInputs' = grammarTrapInputs \cup {InputA}
    /\ retired' = retired \/ Cardinality(grammarTrapInputs \cup {InputA}) >= LatchThreshold
    /\ phase' = "heal-a"

HealA ==
    /\ phase = "heal-a"
    /\ grammarTrapInputs' = IF Decay THEN grammarTrapInputs \ {InputA}
                              ELSE grammarTrapInputs
    /\ UNCHANGED retired
    /\ phase' = "trap-b"

TrapB ==
    /\ phase = "trap-b"
    /\ grammarTrapInputs' = grammarTrapInputs \cup {InputB}
    /\ retired' = retired \/ Cardinality(grammarTrapInputs \cup {InputB}) >= LatchThreshold
    /\ phase' = "heal-b"

HealB ==
    /\ phase = "heal-b"
    /\ grammarTrapInputs' = IF Decay THEN grammarTrapInputs \ {InputB}
                              ELSE grammarTrapInputs
    /\ UNCHANGED retired
    /\ phase' = "done"

Retire ==
    /\ phase # "done"
    /\ Cardinality(grammarTrapInputs) >= LatchThreshold
    /\ retired' = TRUE
    /\ UNCHANGED <<phase, grammarTrapInputs>>

Next == TrapA \/ HealA \/ TrapB \/ HealB \/ Retire
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ phase \in {"trap-a", "heal-a", "trap-b", "heal-b", "done"}
    /\ grammarTrapInputs \subseteq {InputA, InputB}
    /\ retired \in BOOLEAN

NoRetireAfterTwoHealed == retired = FALSE
=============================================================================
