import { describe, expect, it, vi } from "vitest";

describe("dispatch session warm/first-use liveness (#1394)", () => {
	it("uses one warmed promise and executes dispatch work at first use", async () => {
		const ran = vi.fn(async () => ({ diagnostics: [{ tool: "dispatch" }] }));
		vi.doMock("../../../clients/dispatch/integration.js", () => ({
			dispatchLintWithResult: ran,
		}));
		const { warmDispatchIntegration, loadDispatchIntegration } = await import(
			"../../../clients/dispatch/lazy.js"
		);

		// Session-shaped lifecycle: session_start warms without awaiting, then the
		// first tool_result awaits the same promise before doing real work.
		const warm = warmDispatchIntegration();
		const firstUse = await loadDispatchIntegration();
		const result = await firstUse.dispatchLintWithResult(
			"file.ts",
			process.cwd(),
			{ getFlag: () => undefined },
		);

		expect(await warm).toBe(firstUse);
		expect(ran).toHaveBeenCalledTimes(1);
		expect(result.diagnostics).toHaveLength(1);
	});
});
