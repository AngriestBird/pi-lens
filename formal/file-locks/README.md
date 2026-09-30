# Pid-file lock models (#3447)

TLA+ models of the path-based pid-file locks and of the generation lock that
replaced them. The `TLA+ models` CI job model-checks every config here with
TLC and compares the verdict with the config's first line, so a config that
documents a known bug expects the violation:

```text
\* expect: violated MutualExclusion
\* module: FileLock
```

When a fix lands, its config changes to `\* expect: pass` in the same PR. Run
the check locally with `node scripts/check-tla-models.mjs`: it downloads the
pinned `tla2tools.jar` to `.cache/` and verifies its sha256. It needs Java.

## Models

**`FileLock.tla`** covers both locks that create a pid file with `wx`:
- `clients/instance-registry-lock.ts` before #3476 (`Registry*.cfg` other
  than `RegistryCrash.cfg`), guarding the registry read-modify-write in
  `clients/instance-registry.ts`;
- `acquireBoundedPidFileLock` in `clients/bounded-pid-file-lock.ts` before
  #3476 (`Bounded*.cfg`), guarding `commitDurableStore`.

Each acquisition creates a new file. The exclusive create and the pid write
are separate steps unless `AtomicCreate`. Stale takeover and release act on
whatever file the path names at that moment.

**`GenerationLock.tla`** is the generation lock shipped by #3476 and used by
the registry, bounded, quarantine and installer locks since then. The lock is
a series of files `lock.1`, `lock.2`, … Every acquisition, including a stale
takeover, is an exclusive create of the next generation, so nothing is removed
by path. `clients/generation-lock.ts` implements it. The four locks differ
only in the lease, which the model does not distinguish, so
`RegistryCrash.cfg` and `RegistryCrash4.cfg` cover all four. A
`BoundedCrash.cfg` that ran the same module with the same constants was
dropped for that reason; before #3476 it ran `FileLock` and violated
`MutualExclusion`, as `RegistryCrash.cfg` did. `ListedMarker = TRUE` judges as
that code does: the released marker is read from the listing, and a generation
file that is gone reads as held. The code creates a generation with `wx`
rather than linking a written temp file (hard links fail on FAT/exFAT); a
judge that reads it before its pid is written holds it live until it ages out,
which only makes `Free` false in more states than the model's atomic create.

**`GenerationHeartbeat*.cfg` and `GenerationNoHeartbeat.cfg`** model #3515's
install-lock lease. The installer lease is the install timeout plus 60 s slack
(180 s by default), shorter than `installNpmTool`'s two 120 s attempts inside
one hold, so #3553 added two independent defenses in
`clients/generation-lock.ts`: `startGenerationHeartbeat` (an unref'd
`setInterval` touching the held generation's mtime every
`heartbeatIntervalMs(lease) = lease/4`), and `ownsTopGeneration` (true only
while the hold is still the live top generation), read as `assertOwnsLock` in
`clients/installer/index.ts` before each `runInstallAttempt` spawn. The
quarantine lock's async holder gets the same heartbeat
(`clients/bounded-pid-file-lock.ts`). In the model `Heartbeat` rides the
renewal, `HeartbeatStall` is one missed interval, and `OwnsTop` gates the
re-check before `CsWrite`. A renewal that lands keeps a live holder fresh, so
`Expire` is enabled only in a stalled interval.

While the pre-#3476 lock files are also taken (#3489), the bounded lock's old
file is judged by pid liveness alone, so a live bounded holder is never
superseded even past its 5 s generation lease; the model's `AllowExpiry`
applies to it only once that bridge is removed.

## Invariants

- `MutualExclusion`: at most one live process is inside the critical section.
- `NoLostRegistration`: an update the writer saw committed is still there.
- `NoOrphanLock`: a fresh lock belongs to a live owner that will release it.
- `NoLiveTakeover`: a live owner's unreleased generation is never judged
  stale, so a contender can never supersede a live holder. The lease
  (`AllowExpiry`) is the only way that judgement can be reached, so the
  heartbeat that keeps the lease from lapsing is what makes this hold.

## Results

| Config | Faults | Verdict |
|---|---|---|
| `RegistryNoFault.cfg` | none | pass |
| `RegistryCrash.cfg` | one writer dies | pass on the generation lock (#3476); `MutualExclusion` violated on the path lock before |
| `RegistryCrash4.cfg` | the generation lock, four writers, two die | pass |
| `RegistryCrashNoRecheck.cfg` | the generation lock, no second listing | `MutualExclusion` violated |
| `RegistryExpiry.cfg` | a holder outlives 5 s | `MutualExclusion` violated (the lease) |
| `RegistryCrashFix.cfg` | crash, identity-checked takeover | `NoOrphanLock` violated |
| `RegistryCrashFix4.cfg` | the same, four writers | `MutualExclusion` violated |
| `BoundedNoFault.cfg` | none | pass (fixed in #3475; `MutualExclusion` violated before) |
| `BoundedLinkedNoFault.cfg` | none, lock linked from a written temp file | pass (the alternative #3475 considered) |
| `GenerationNoFault.cfg` | none | pass |
| `GenerationCrash.cfg` | one writer dies, two rounds each | pass |
| `GenerationCrash4.cfg` | four writers, two die | pass |
| `GenerationNoRecheck.cfg` | crash, no second listing | `MutualExclusion` violated |
| `GenerationExpiry.cfg` | a holder outlives the threshold | `MutualExclusion` violated (the lease) |
| `GenerationHeartbeat.cfg` | one writer dies, heartbeat and re-check wired | pass |
| `GenerationNoHeartbeat.cfg` | no heartbeat, no re-check, lease shorter than the hold | `NoLiveTakeover` violated |
| `GenerationHeartbeatStall.cfg` | one missed heartbeat interval | `NoLiveTakeover` violated (the re-check keeps `MutualExclusion`) |
| `GenerationHeartbeatStallNoCheck.cfg` | missed interval, no re-check | `MutualExclusion` violated |

Four results matter most:

- **The registry lock** holds without faults, including the window where its
  file exists but has no pid yet (#3450). With a crash, two takers of the dead
  owner's lock can each remove what the path names, and both enter.
- **The bounded lock** failed with no crash at all: an empty file parsed to
  `NaN`, which read as a dead owner, so a contender unlinked a live lock.
  #3475 fixed it: a lock with no parseable pid is live until its mtime is
  5 s old, as the registry lock already read it. Linking a fully written
  temp file into place also passes, but hard links fail on FAT/exFAT and
  some network shares.
- **The identity-checked takeover** (restore the displaced file if it was not
  the judged one) only narrows the crash race, and it was the quarantine
  lock's shape before #3476. The generation lock closes it in the model.
  The post-create listing is required: without it, a stale listing
  re-creates a name cleanup removed.
- **The install heartbeat** is two independent defenses. With no heartbeat and
  no ownership re-check, the lease lapses under a live holder, so
  `GenerationNoHeartbeat.cfg` violates `NoLiveTakeover` and a second installer
  can take over. A missed heartbeat interval without the re-check lets two
  live holders overlap (`GenerationHeartbeatStallNoCheck.cfg` violates
  `MutualExclusion`); adding the re-check keeps the overlap closed even though
  a live holder was still taken over (`GenerationHeartbeatStall.cfg` violates
  `NoLiveTakeover` only). The model collapses the re-check, its spawn and the
  write into `CsWrite`, so the stalled cases do not explore a taker landing
  between the real check and the real spawn.

The model is not passing vacuously: letting the `wx` create succeed on an
occupied path makes `RegistryNoFault.cfg` violate `MutualExclusion`.

## Repros on the real code

Run from the repository root after `npm run build`. Each script delays one
step to force the interleaving TLC found; neither changes the lock's logic.

```text
$ node formal/file-locks/repro-registry-double-takeover.mjs   # before #3476
p3: p2 is in its critical section; lock now reads "23804 1790370894347" (p2 pid)
p3: in critical section (pid 23796); p2 still inside: true
p3: MUTUAL EXCLUSION VIOLATED

$ node formal/file-locks/repro-bounded-empty-window.mjs   # before #3475
B: A's lock exists, content: ""
B: acquired
B: A entered while B held the lock: MUTUAL EXCLUSION VIOLATED

$ node formal/file-locks/repro-bounded-empty-window.mjs   # after #3475
B: A's lock exists, content: ""
B: acquired
B: exclusive
```

Since #3476 the registry lock has no rename for the first script to hold, so
it no longer reaches the race. `tests/clients/instance-registry-lock.test.ts`
replays the same interleaving on any lock layout by holding the stale
judgement's liveness probe (`admits one of two takers of a dead owner's lock`).

## Scope

Not modelled:
- backoff timing (any retry may give up, as the wait deadline does);
- pid reuse;
- the quarantine lock before #3476, whose restore had the shape of
  `RegistryCrashFix.cfg`;
- writers from before #3476 running beside current ones. A registry,
  bounded or quarantine generation holder also holds the old `.lock` file
  (a directory for the quarantine lock) so they block each other, and a
  stale one keeps the old path takeover race against an older writer.
