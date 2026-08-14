import { performance } from "node:perf_hooks";

// Capture this before the guard's other module initialization so host boot is
// not charged to extension evaluation (#1374).
export const PI_LENS_EVAL_STARTED_MS = performance.now();

// #1333: install the console guard as an import side-effect so it runs before
// any other module's initialization code. Installing inside the extension
// factory is too late — by the time the factory runs, every static/transitive
// import has already evaluated, so a dependency writing to console during
// module init would still hit the TUI raw (#1338 review finding). This module
// MUST remain the first import of index.ts; the enforcement test pins that.
// installConsoleGuard() itself is idempotent and no-ops under test mode and
// PI_LENS_CONSOLE_GUARD=0.
import { installConsoleGuard } from "./extension-log.js";

installConsoleGuard();
