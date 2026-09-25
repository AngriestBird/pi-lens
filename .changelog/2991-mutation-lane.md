---
section: Fixed
---

- Make the mutation-diff lane actually evaluate mutants: mutate only the diff's changed lines, give instrumented related tests their own timeout, and bound the run below the job cap so a lane that evaluated nothing says so.
