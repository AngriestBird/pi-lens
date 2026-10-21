import {
	configureLspServiceLifecycle,
	resetOwnedLspService,
} from "../../clients/lsp/service-singleton.js";
import {
	type LspServiceDoubleOptions,
	makeLspServiceDouble,
	type LspServiceOverrides,
} from "./lsp-service-double.js";

/**
 * Install the LSP service double through the REAL singleton lifecycle seam
 * (#4709).
 *
 * `clients/lsp/capabilities.ts` and `clients/lsp/index.ts` both read the one
 * process singleton in `clients/lsp/service-singleton.ts`, and the host
 * installs its own lifecycle there at import (`clients/lsp/index.ts`). A test
 * that wants a fake service therefore has a first-class seam: replace the
 * lifecycle, and every caller of `getLSPService()` — the grouped facade and the
 * flat compatibility export alike — gets the double. `vi.mock` of the facade
 * was only ever approximating that: it replaced the module, so the production
 * singleton was never exercised, and the double it returned was the raw object
 * rather than the adapted one production sees.
 *
 * Why a helper instead of the six lines at every call site: 85 test files
 * mocked this one module (AGENTS.md shape 66, #4709), and four already
 * hand-rolled the same reset-then-configure dance. The dance has an ORDER that
 * matters in both directions, and getting either wrong is silent:
 *
 * 1. RESET FIRST, while the lifecycle still installed is the previous case's.
 *    `clients/lsp/index.ts` re-evaluates on `vi.resetModules()`, and its
 *    import-time configure replaces the lifecycle with the host's real one,
 *    whose `destroy` calls `shutdown()` on a double that has none.
 * 2. THEN evaluate the facade, so a re-evaluated graph has installed its own
 *    lifecycle before this one is layered on top. Without this step a file
 *    that dynamic-imports its subject
 *    (`tests/clients/actionable-warnings-lsp-cache.test.ts`,
 *    `tests/clients/warm-attach-confirmation.test.ts`) overwrites the double
 *    from inside the case.
 * 3. THEN configure.
 *
 * The install is NOT eager: a file whose path never asks for a service keeps
 * `peekLSPService()` undefined, exactly as it was when the module was mocked.
 * The double is a plain `makeLspServiceDouble` surface (this module resolves to
 * the double, not to `adaptLspService`'s facade), so the documented
 * focused-override shape still applies.
 *
 * The reset is per install, in BOTH entry points (#4720 review F1/F2). A second
 * install must not keep serving the first one's cached service: that is what the
 * next slice's per-case doubles depend on, and it is silent when wrong, because
 * a file-scoped hoisted spy answers identically from a stale double.
 */
export async function installLspServiceDouble(
	overrides: LspServiceOverrides = {},
	options: LspServiceDoubleOptions = {},
): Promise<Record<string, unknown>> {
	resetInstalledLspService();
	await import("../../clients/lsp/capabilities.js");
	return configureInstalledService(makeLspServiceDouble(overrides, options));
}

/**
 * Install an already-built service object, synchronously, replacing whatever the
 * previous install left cached. Three call sites in three files, besides the
 * seam's own witness (`grep -rn "installLspService(" tests`):
 * `tests/clients/dispatch/runners/lsp-environment-gap-4532.test.ts`,
 * `tests/clients/lsp/out-of-band-client-root-4532.test.ts` and
 * `tests/tools/lsp-diagnostics-inferred-project.test.ts`. They need no reset of
 * their own: this one runs first and replaces a cached service (#4720 F2). A
 * caller that resets too is harmless, because a second reset over an empty
 * singleton returns before any teardown.
 *
 * A file that has not evaluated the facade's graph yet must use the async form:
 * installing before `clients/lsp/index.ts` evaluates is what its third step
 * exists to avoid, and it fails silently.
 */
export function installLspService(
	service: Record<string, unknown>,
): Record<string, unknown> {
	resetInstalledLspService();
	return configureInstalledService(service);
}

/** The configure step both installers share; it never resets, so each entry
 * point owns exactly one reset and each one is witnessed on its own (#4720). */
function configureInstalledService(
	service: Record<string, unknown>,
): Record<string, unknown> {
	configureLspServiceLifecycle<Record<string, unknown>>({
		create: () => service,
		beforeReset: () => undefined,
		destroy: async () => undefined,
	});
	return service;
}

/**
 * Drop the installed service from the process singleton without rebuilding it.
 * The next `getLSPService()` asks the installed lifecycle for a fresh one, so a
 * case that asserts a post-reset state sees the same double again rather than a
 * stale cached instance. Module-private: both installers are its callers, and
 * `tests/clients/lsp-service-seam.test.ts` is the witness for each.
 */
function resetInstalledLspService(): void {
	resetOwnedLspService();
}
