import { describe, expect, it, vi } from "vitest";

describe("formatter session warm/first-use liveness (#1394)", () => {
	it("warms the catalog and executes formatting through the same promise", async () => {
		const formatFile = vi.fn(async () => ({ success: true, changed: true }));
		vi.doMock("../../clients/formatters.js", () => ({
			formatFile,
			getFormattersForFile: async () => [],
			listAllFormatters: () => [],
			clearFormatterRuntimeState: vi.fn(),
		}));
		const { warmFormatters, loadFormatters } = await import(
			"../../clients/formatters-lazy.js"
		);
		const warm = warmFormatters();
		const firstUse = await loadFormatters();
		await firstUse.formatFile("file.ts", { name: "test" } as never);

		expect(await warm).toBe(firstUse);
		expect(formatFile).toHaveBeenCalledTimes(1);
	});
});
