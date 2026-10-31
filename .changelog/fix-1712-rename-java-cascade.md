---
section: Changed
audience: internal
---

- The nightly live cascade lane gains a typescript-go rename phase: it restores the exporter, moves it through `LSPService.renameFile` and requires each importer to reach the verdict its file calls for (refs #1712). Java stays out of `CASCADE_GRAPH_KINDS` until a push-only server's cached importer answer stops reading as confirmed clean (#5040); the java row is a declared `known-defect` row, not a skip.
