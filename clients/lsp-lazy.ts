/** Shared lazy LSP service seam (#1394). */
import { createLazyImport } from "./lazy-import.js";

type LspModule = typeof import("./lsp/capabilities.js");
const lazyLsp = createLazyImport<LspModule>(
	() => import("./lsp/capabilities.js"),
);

export function warmLspService(): Promise<LspModule> {
	return lazyLsp.get();
}

export function loadLspService(): Promise<LspModule> {
	return warmLspService();
}
