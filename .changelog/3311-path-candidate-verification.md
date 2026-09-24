---
section: Fixed
---

- A tool the installer finds on `PATH` is now probed with that tool's own
  check before it is resolved, the way every other rung of the resolution
  ladder already was. A file on `PATH` that cannot actually run — rustup's
  `rust-analyzer` proxy on a box where that component was never installed, a
  `pipx`-installed `cmake-language-server` whose venv resolved a pygls that
  removed the symbol it imports — no longer shadows the managed install that
  works, and no longer reports as an available server that then never answers.
  A probe that stalls or cannot be read still resolves as before: a kill is not
  a verdict. `cmake-language-server` also pins its pygls floor, and that pin now
  reaches whichever resolver pipx picked — pip and uv each read the same
  constraints file through their own environment variable — so the install stops
  producing a launcher that cannot start (refs #3311).
