# ORCHESTRATOR SUMMARY

- PR: https://github.com/apmantza/pi-lens/pull/4017 (draft)
- Published head: `5275a273c865974e0c00723b4256c6f475ede6a1`
- Ref: `sub-muxqvcqz-6` (detached checkout publication ref)
- Fix: queued/in-progress registered `ci.yml` runs now say to wait; positive-empty run lookup remains the only re-arm admission.
- Red: pre-fix real `run()` fixture, 5 failures / 244 tests; old wording was received.
- Mutation red: compile-valid restoration of old production wording, 5 failures / 244 tests.
- Green: all 5 ci-verdict files, 475/475 tests.
- Push hook: 32 targeted/governance files, 1,085 passed / 1 skipped.
- Exact-head verdict: `ci-verdict: exit 3 (pending)`; required CI is queued, not green.
- Decision: review/CI must complete; do not merge while the exact-head verdict is pending.

## Change

`formatAbsentRunReason` now renders:

```text
ci.yml run 37584049673 is queued (0 min old) for 5275a273c865974e0c00723b4256c6f475ede6a1: wait for the registered run to finish; no re-arm is needed
```

Terminal runs retain manual inspect/rerun guidance. A valid empty `workflow_runs` array still renders the re-arm advice; unreadable, wrong-head, merge-group, and other-workflow responses do not.

## Evidence

Red-first real fixture:

```text
Test Files  1 failed (1)
Tests  244 passed | 5 failed (244)
Expected: "...: wait for the registered run to finish; no re-arm is needed"
Received: "...: the run is registered, so no re-arm is needed"
```

Compile-valid mutation:

```text
Test Files  1 failed (1)
Tests  239 passed | 5 failed (244)
Expected: "...: wait for the registered run to finish; no re-arm is needed"
Received: "...: the run is registered, so no re-arm is needed"
```

Targeted green:

```text
Test Files  5 passed (5)
Tests  475 passed (475)
```

Required local gates passed: `npm run lint`, `npm run astgrep:self-scan`, `npx oxfmt --check scripts/ci-verdict.mjs tests/scripts/ci-verdict.test.ts`, PR-body lint, changelog-fragment validation, and the pre-push hook.

Exact-head CI read, once and without `--wait`:

```text
ci.yml run 37584049673 is queued (0 min old) for 5275a273c865974e0c00723b4256c6f475ede6a1: wait for the registered run to finish; no re-arm is needed
ci-verdict: exit 3 (pending)
```

Full suite was not run locally; CI must execute it. No CI check is claimed green from this handback.
