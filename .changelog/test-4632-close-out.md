---
section: Changed
audience: internal
---

- **A certified-host tier spread exists, and the `pending slice` class is retired (#4632)** —
  `scripts/probe-pi-host-tiers.mjs` runs tier 1 and tier 2 against every certified
  pi host installed on the machine, reading the certified set from the baseline
  doc's verified-host table (the same reader the packaging ratchet now uses), and
  prints one line per host naming the host and the version it ran on. Each tier
  loads the probed host's own code, so a host directory that cannot supply it
  fails the tier instead of being reported as probed. It installs nothing: an
  absent host is reported `not installed`, and `--require-all` is what makes that
  a failure. `tests/config/pi-mock-importer-sweep.test.ts` no longer admits the
  `pending slice N` class, whose last row left with the roadmap, so a reopened
  placeholder reds instead of reading as scheduled work.
