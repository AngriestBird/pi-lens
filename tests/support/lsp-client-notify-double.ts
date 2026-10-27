/**
 * The whole `notify` surface of a hand-built LSP client double.
 *
 * A double that names only the members its own test calls breaks the moment a
 * production route reaches another one: #4926 review F1, where the workspace
 * sweep's call to `announceCreatedFiles` reached `notify.watchedFileChange`
 * and two sweep tests failed with `watchedFileChange is not a function`. The
 * return type is the client's own `notify` type, so a member added to the
 * client fails the type check here, once, instead of a test at run time.
 */
import { vi } from "vitest";
import type { LSPClientInfo } from "../../clients/lsp/client.js";

export function makeClientNotifyDouble(
	overrides: Partial<LSPClientInfo["notify"]> = {},
): LSPClientInfo["notify"] {
	return {
		open: vi.fn(async () => undefined),
		change: vi.fn(async () => undefined),
		save: vi.fn(async () => true),
		watchedFileChange: vi.fn(),
		flushWatched: vi.fn(),
		announceCreated: vi.fn(),
		...overrides,
	};
}
