/**
 * #1789: `LSPService.workspaceSymbol` must not send `workspace/symbol` to a
 * server that never advertised `workspaceSymbolProvider` in its initialize
 * result. Without a `filePath`, the target is `this.state.clients`' first
 * entry by insertion order — every spawned client, auxiliary scanners
 * (ast-grep, opengrep, zizmor, ...) included, not just primary language
 * servers. A workspace whose only spawned client (yet) is an auxiliary sent
 * every workspace-wide symbol query to it, wasting a round trip per call
 * (dogfood: 2026-08-20, ast-grep). The gate reuses the same single source of
 * truth `lsp-document-symbols.ts`'s documentSymbol gate reads —
 * `client.getOperationSupport().<key>`, populated from the initialize
 * result's `capabilities` (clients/lsp/client.ts `detectOperationSupport`) —
 * rather than a second, hand-rolled capability check.
 */

import { describe, expect, it, vi } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";

function makeFakeClient(supportsWorkspaceSymbol: boolean) {
	const workspaceSymbol = vi.fn(async () => [
		{ name: "greet", kind: 12 },
	]);
	return {
		workspaceSymbol,
		getOperationSupport: () => ({
			definition: false,
			typeDefinition: false,
			declaration: false,
			references: false,
			hover: false,
			signatureHelp: false,
			documentSymbol: false,
			workspaceSymbol: supportsWorkspaceSymbol,
			codeAction: false,
			rename: false,
			implementation: false,
			callHierarchy: false,
		}),
	};
}

function injectClient(svc: LSPService, key: string, client: unknown) {
	(
		svc as unknown as { state: { clients: Map<string, unknown> } }
	).state.clients.set(key, client);
}

describe("LSPService.workspaceSymbol capability gate (#1789)", () => {
	it("does not call workspaceSymbol on a client that never advertised workspaceSymbolProvider", async () => {
		const auxOnly = makeFakeClient(false);
		const svc = new LSPService();
		// The only spawned client is an auxiliary (e.g. ast-grep) that never
		// advertised workspaceSymbolProvider — this is "the first active
		// client" `workspaceSymbol(query)` resolves to when no path is given.
		injectClient(svc, "ast-grep:root", auxOnly);

		const result = await svc.workspaceSymbol("greet");

		expect(auxOnly.workspaceSymbol).not.toHaveBeenCalled();
		// Caller-visible shape must match what an unsupported/failed request
		// already produced (client.ts's workspaceSymbol maps `result ?? []`
		// to `[]`) — the gate only removes the wasted round trip, not the
		// empty-result contract.
		expect(result).toEqual([]);
	});

	it("still calls workspaceSymbol when the first active client advertises support", async () => {
		const primary = makeFakeClient(true);
		const svc = new LSPService();
		injectClient(svc, "typescript:root", primary);

		const result = await svc.workspaceSymbol("greet");

		expect(primary.workspaceSymbol).toHaveBeenCalledWith("greet");
		expect(result).toEqual([{ name: "greet", kind: 12 }]);
	});

	// F1 (review round): the filePath branch resolves its own target via
	// getClientForFile, independent of the no-filePath "first active client"
	// branch above — a separate guard, at a separate line, with a separate
	// reachable path (openFileBestEffort can spawn a NEW client between the
	// tool layer's own capability read and this service call landing, so the
	// server this branch actually calls is not guaranteed to be the one the
	// caller already checked). Deleting this guard must fail this test even
	// though the no-filePath tests above stay green.
	it("does not call workspaceSymbol on the filePath-resolved client when it lacks support", async () => {
		const resolved = makeFakeClient(false);
		const svc = new LSPService();
		svc.getClientForFile = vi
			.fn()
			.mockResolvedValue({ client: resolved, info: {} });

		const result = await svc.workspaceSymbol("greet", "C:/repo/main.ts");

		expect(resolved.workspaceSymbol).not.toHaveBeenCalled();
		expect(result).toEqual([]);
	});

	it("still calls workspaceSymbol on the filePath-resolved client when it advertises support", async () => {
		const resolved = makeFakeClient(true);
		const svc = new LSPService();
		svc.getClientForFile = vi
			.fn()
			.mockResolvedValue({ client: resolved, info: {} });

		const result = await svc.workspaceSymbol("greet", "C:/repo/main.ts");

		expect(resolved.workspaceSymbol).toHaveBeenCalledWith("greet");
		expect(result).toEqual([{ name: "greet", kind: 12 }]);
	});
});
