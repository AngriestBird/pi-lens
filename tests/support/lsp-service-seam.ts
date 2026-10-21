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
 * The double is a plain `makeLspServiceDouble` surface, so the documented
 * focused-override shape still applies.
 */
export async function installLspServiceDouble(
	overrides: LspServiceOverrides = {},
	options: LspServiceDoubleOptions = {},
): Promise<Record<string, unknown>> {
	resetInstalledLspService();
	await import("../../clients/lsp/capabilities.js");
	return installLspService(makeLspServiceDouble(overrides, options));
}

/**
 * Install an already-built service object, synchronously. Two callers only:
 * a file that re-installs mid-case (the graph is evaluated by then), and
 * {@link installLspServiceDouble}, which has just evaluated it. A file that has
 * not imported the facade's graph yet must use the async form: installing
 * before `clients/lsp/index.ts` evaluates is what the third step exists to
 * avoid, and it fails silently.
 */
export function installLspService(
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
 * stale cached instance.
 */
export function resetInstalledLspService(): void {
	resetOwnedLspService();
}
