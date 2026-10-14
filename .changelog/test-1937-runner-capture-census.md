---
section: Changed
audience: internal
---

- **Every dispatch runner now needs captured real-binary bytes or a reasoned exemption (#1937)** — `tests/clients/dispatch/smoke-fixture-coverage.test.ts` counts captured fixtures only, no longer a live smoke fixture, and rejects deferral phrasing such as "no fixture yet". The census recaptured 13 more runners (cue-vet, go-vet, zig-check, gleam-check, elixir-check, javac, ktlint, dart-analyze, rust-clippy, dotnet-build, fish-indent, swiftlint, cpp-check) and left four live-only runners exempt with the missing toolchain named.
