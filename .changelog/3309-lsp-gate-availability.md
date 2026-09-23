section: Fixed

The LSP clean gate now uses the diagnostics handler's real no-client decision instead of short-circuiting on installer availability, so handshaking language-toolchain servers are gated.
