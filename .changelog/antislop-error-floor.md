---
section: Changed
---

- **Anti-slop rules: one promotion to `error`, six deliberate holds
  ([refs #1727](https://github.com/apmantza/pi-lens/issues/1727),
  [refs #1777](https://github.com/apmantza/pi-lens/issues/1777))** —
  `require-safety-comment-for-as-unknown-as` moves from `hint` to `error`,
  the tier that blocks a turn. Two changes earn that. The rule now excludes
  test paths structurally, because a four-corpus census (pi-lens, pi core,
  opencode, oh-my-pi) found 79–95% of `x as unknown as T` sites live in test
  doubles; and each of the 16 remaining `clients/` casts was read and given a
  truthful `SAFETY:` comment naming the invariant, with the one unjustified
  cast replaced instead (`clients/runtime-context.ts` no longer casts `null`
  into a cache entry's type). `no-chained-type-assertions` drops its
  `as unknown as` arm, so the two rules now partition the assertion space
  rather than both reporting the same site — every uncommented cast used to
  raise two diagnostics for one defect. Both rules are wired into the CI
  self-scan, which holds pi-lens's own tree at zero.

  The other six #1727 rules — `no-known-value-widening`, `no-runtime-typeof`,
  `no-shape-in-symbol-names`, `no-unknown-parameters`, `no-unknown-returns`,
  `no-unsafe-dictionary-unknown` — stay at `hint`. Structural narrowing was
  attempted on each and none reached a clean census; the residuals run from
  3 to 3,239 legitimate hits per corpus. Every rule's note now carries its
  four-corpus numbers and the reason it stopped, and AGENTS.md's severity
  policy records the promotion procedure those censuses follow.
