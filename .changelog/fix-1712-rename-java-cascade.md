---
section: Fixed
audience: user
---

- **A Java edit now cascades to the files that import it.** `computeCascadeForFile` skipped every Java file with `non_code` because `java` was missing from `CASCADE_GRAPH_KINDS`, although the review graph already resolved Java imports; the file kind is now in the set, so a broken exporter reports its importers (and the MCP warm `pilens_analyze` keeps the graph for Java files). The nightly live cascade lane measures it against jdtls, and a typescript-go rename phase restores the exporter, moves it through `LSPService.renameFile` and requires each importer to reach the verdict its file calls for. jdtls republishes some importers of an edited exporter and not others, so the cascade can still read an importer as clean there; the java row warns with that cause (refs #1712)
