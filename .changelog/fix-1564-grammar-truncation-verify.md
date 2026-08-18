---
section: Fixed
---

- **A truncated grammar download no longer poisons the file permanently ([#1564](https://github.com/apmantza/pi-lens/issues/1564))** — the #1548/#1560 wasm-magic check catches a captive portal's HTML, but a connection dropped mid-transfer still starts with a genuine `\0asm` preamble, so it passed. The runtime download path now verifies the full body against the pinned sha256 in `scripts/grammars.lock.json` (the same manifest the postinstall path already trusts), falling back to a Content-Length compare when no pinned hash is available. A `Language.load` failure on a file resolution just vouched for now also records a degradation naming the grammar and the loader's error, and invalidates the resolve memo so the next demand re-fetches instead of reusing the same broken file forever.
