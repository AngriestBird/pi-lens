/**
 * #4346: the producer for a module created outside pi-lens (a shell, `cp`,
 * codegen, another editor). No tool result names such a file, so no Created
 * reaches a language server that caches a failed lookup (Pyrefly and pyright,
 * measured), and its importer keeps reporting the missing import for the
 * server's life when only the importer is diagnosed.
 *
 * The importer is the one input that names the module, and it is in hand when
 * a diagnostics call is about to answer for it. So before a batch answers, the
 * files its importers resolve to now (`extractForwardImportPaths`, the
 * tree-sitter import extraction and the review graph's resolvers, which the
 * inline-blocker sweep also uses) join the files announced
 * through `LSPService.announceCreatedFiles`. Each client still decides what is
 * new to it (#4344's path-birth rule and announced memory), so an old module,
 * or one already announced, sends nothing.
 *
 * Bounded: at most {@link CREATED_IMPORT_SCAN_MAX_FILES} importers per call.
 * Importers past the cap are recorded once per session
 * (`lsp-created-import-scan-incomplete`). A dependency no import names (a
 * TypeScript ambient declaration, a Go same-package file) is outside it.
 */
import { recordDegradationOnce } from "../degradation-ledger.js";

/** Importers resolved per diagnostics call. */
export const CREATED_IMPORT_SCAN_MAX_FILES = 32;

/** The files `importers` import now, deduplicated, for `announceCreatedFiles`. */
export async function importTargetsToAnnounce(
	cwd: string,
	importers: readonly string[],
): Promise<string[]> {
	if (importers.length === 0) return [];
	if (importers.length > CREATED_IMPORT_SCAN_MAX_FILES) {
		recordDegradationOnce({
			kind: "lsp-created-import-scan-incomplete",
			subject: "capped",
			reason: `resolved the imports of ${CREATED_IMPORT_SCAN_MAX_FILES} of ${importers.length} files in one diagnostics call`,
		});
	}
	// Lazy: the import extraction stack stays off the LSP module graph until a
	// call has an importer to resolve.
	const { extractForwardImportPaths } = await import("../blocker-freshness.js");
	const targets = new Set<string>();
	// Extraction answers [] for a missing, unreadable or non-source file; it
	// does not throw (its own contract, which the blocker sweep relies on too).
	for (const importer of importers.slice(0, CREATED_IMPORT_SCAN_MAX_FILES)) {
		for (const target of await extractForwardImportPaths(cwd, importer)) {
			targets.add(target);
		}
	}
	return [...targets];
}
