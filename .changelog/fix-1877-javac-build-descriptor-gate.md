---
section: Fixed
---

- **javac fallback skips classpath-less compiles inside Maven/Gradle projects (closes #1877)** — when the Java LSP runner misses its wait budget, dispatch falls back to the `javac` runner, which compiles the single file with no `-classpath`/`-sourcepath`. On build-tool projects every non-JDK import becomes a blocking `package does not exist` false positive that gates agent edits and stays cached in session diagnostics after jdtls recovers. The runner now walks up from the edited file with the shared `hasJavaBuildDescriptor` seam (the same gate SpotBugs uses) and returns `skipped` when a `pom.xml`, `build.gradle(.kts)`, or `settings.gradle(.kts)` is present; the dispatcher's coverage notice reports the LSP gap honestly. Standalone `.java` files with no descriptor keep the javac fallback.
