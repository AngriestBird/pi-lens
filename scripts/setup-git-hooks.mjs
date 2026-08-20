#!/usr/bin/env node
// scripts/setup-git-hooks.mjs (#1804)
//
// Wires Husky-managed hooks (.husky/pre-commit, .husky/pre-push) into this
// clone's `core.hooksPath`, as a step inside the `prepare` npm lifecycle
// script. `prepare` also runs `build:dist` + grammar download — steps that
// consumers who install pi-lens as a dependency (`npm install --omit=dev`,
// no .git present, no devDependencies) depend on and that MUST fail loudly
// on error. Hook wiring must never share that failure path with them: it is
// dev-only and best-effort, so it lives in its own script, invoked last, and
// swallows its own errors instead of `|| true`-ing the whole `prepare` chain
// (which would also mask a real build failure).
//
// Skipped, not attempted, when:
//   - PI_LENS_SKIP_HOOKS=1        explicit opt-out (agents/CI set this)
//   - CI=true                     GitHub Actions sets this automatically;
//                                  CI never commits, hooks buy nothing
//   - no .git here                consumer install (dependency, tarball) —
//                                  there is no repo to attach hooks to
//   - no node_modules/husky       devDependencies weren't installed
//                                  (production/consumer install)
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

function skipReason() {
	if (process.env.PI_LENS_SKIP_HOOKS === "1") return "PI_LENS_SKIP_HOOKS=1";
	if (process.env.CI === "true") return "CI=true";
	if (!existsSync(".git")) return "no .git (not a clone)";
	if (!existsSync("node_modules/husky/bin.js")) return "husky not installed (production install)";
	return null;
}

const reason = skipReason();
if (reason) {
	console.log(`[setup-git-hooks] skipped (${reason}).`);
	process.exit(0);
}

try {
	execFileSync(process.execPath, ["node_modules/husky/bin.js"], { stdio: "inherit" });
} catch (error) {
	// Best-effort: a broken git-hooks install must never fail `npm install`.
	console.warn(
		`[setup-git-hooks] husky install failed, continuing without local hooks: ${error instanceof Error ? error.message : error}`,
	);
}
