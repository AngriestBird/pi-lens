---
section: Fixed
---

- **PSScriptAnalyzer's execution-policy regex tightening now has regression tests (refs #1604)** — the #1556 review round tightened `policyDenied`'s detection from a bare `securityerror|execution polic(y|ies)|running scripts is disabled|unauthorizedaccess` alternation to requiring `securityerror` paired with one of the other three, closing a false positive where a bare `UnauthorizedAccessException` (a file-permission error, unrelated to the execution policy) or a stray mention of "execution policy" in unrelated stderr latched `-File` off as a durable policy block. That tightening shipped with no test proving the false positive it closed. Two regression tests now pin it: reverting the regex to the pre-#1556 alternation turns both red, confirming the current AND-conjunction is load-bearing, not vacuous.
