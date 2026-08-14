import { describe, expect, it, vi } from "vitest";

describe("LSP session warm/first-use liveness (#1394)", () => {
	it("warms once and services a first-use request", async () => {
		const request = vi.fn(async () => ({ diagnostics: [] }));
		vi.doMock("../../clients/lsp/index.js", () => ({
			getLSPService: () => ({ request }),
		}));
		const { warmLspService, loadLspService } = await import(
			"../../clients/lsp-lazy.js"
		);
		const warm = warmLspService();
		const firstUse = await loadLspService();
		await firstUse.getLSPService().request("file.ts");

		expect(await warm).toBe(firstUse);
		expect(request).toHaveBeenCalledTimes(1);
	});
});
