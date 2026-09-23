import { describe, expect, it } from "vitest";
import { classifyLspGateResult } from "../../scripts/smoke-tools.mjs";

describe("LSP diagnostics clean-gate classification (#2780/#2776)", () => {
	it("passes only when the real handler reports a primary finding", () => {
		expect(
			classifyLspGateResult(
				{
					details: {
						totalDiagnostics: 1,
						primaryDiagnosticsCount: 1,
						auxiliaryDiagnosticsCount: 0,
					},
				},
			),
		).toMatchObject({ state: "pass", diags: 1 });
	});

	it("reds diagnostics delivered only outside the primary bucket", () => {
		// #2776 recurrence: a custom primary pushed a finding whose source differed
		// from its server id, so the handler returned a diagnostic but rendered zero
		// primary findings. The nightly gate must catch that provenance drift.
		expect(
			classifyLspGateResult(
				{
					details: {
						totalDiagnostics: 1,
						primaryDiagnosticsCount: 0,
						auxiliaryDiagnosticsCount: 1,
					},
				},
			),
		).toMatchObject({ state: "fail", diags: 1 });
	});

	it("skips a server whose declared tool is unavailable", () => {
		// #3309 recurrence: installer availability can disagree with a real
		// language-toolchain server. The gate must use the handler's no_clients
		// decision, not an ensureTool preflight.
		expect(
			classifyLspGateResult({
				details: {
					unavailable: "LSP unavailable for /tmp/bad.lua: no LSP client is currently ready",
				},
			}),
		).toMatchObject({
			state: "skip",
		});
	});

	it("fails when the handler ran but returned no primary finding", () => {
		expect(
			classifyLspGateResult(
				{ details: { totalDiagnostics: 0, primaryDiagnosticsCount: 0 } },
			),
		).toMatchObject({ state: "fail" });
	});
});
