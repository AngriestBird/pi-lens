---
section: Fixed
---

- **Tool schemas survive registration on hosts with callable schemas (closes #3195)** — On a host whose `typebox` specifier resolves to an ArkType-style builder — `@oh-my-pi/pi-coding-agent` (the `@oh-my-pi/omptype` shim it rewrites an extension's `typebox` import to), and any other host whose schema builders return callables — every pi-lens tool lost its parameter schema at registration: the console-capture seam replaced each function-valued property of a tool definition with a capture wrapper, and a schema is itself a function there. All 13 tools then rendered `type Args = unknown;` and rejected every `xd://` call with `root: schema must be an object or boolean`. Callable schemas are now handed to the host untouched, using the host's own `isArkSchema` test, while `execute`, `renderResult` and command handlers keep their console-capture window. Hosts whose schemas are plain objects (`@earendil-works/pi-coding-agent`) are unaffected.
