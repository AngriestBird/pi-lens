import { describe, expect, it } from "vitest";
import {
	normalizeBiomeSeverity,
	parseBiomeJson as parseBiomeJsonImpl,
} from "../../../../clients/dispatch/runners/biome-check.js";

/****************************************************************
 * NOTE: This test file tests the Biome JSON parser logic.
 *
 * The actual biome-check runner spawns the biome CLI binary,
 * which isn't available in tests. Instead, we test the JSON
 * parsing logic directly with mock Biome JSON output, importing
 * the REAL `parseBiomeJson`/`normalizeBiomeSeverity` from the
 * compiled runner rather than an inlined copy (#1791) — a private
 * copy here would silently drift from the shipped mapping.
 *
 * To run integration tests with the actual biome binary,
 * use the doctor command or manual testing.
 ****************************************************************/

describe("biome-check JSON parser", () => {
	function parseBiomeJson(raw: string, filePath: string) {
		return parseBiomeJsonImpl(raw, filePath).diagnostics;
	}

	describe("parseBiomeJson", () => {
		it("parses error diagnostics correctly", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						category: "noShadow",
						message: "Do not shadow variables",
						location: {
							source: "test.ts",
							start: { line: 10, column: 5 },
							end: { line: 10, column: 8 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/src/test.ts");

			expect(result).toHaveLength(1);
			// #1791: toMatchObject, not toEqual — the real parser also carries
			// fixable/autoFixAvailable/fixKind (driven by getAutofixCapability),
			// which the old test's private inlined copy never produced.
			expect(result[0]).toMatchObject({
				id: "biome:noShadow:10",
				message: "Do not shadow variables",
				filePath: "/src/test.ts",
				line: 10,
				column: 5,
				severity: "error",
				semantic: "blocking",
				tool: "biome",
				rule: "noShadow",
			});
		});

		it("parses warning diagnostics as non-blocking", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "warning",
						category: "preferOptionalChain",
						message: "Use optional chaining instead",
						location: {
							source: "test.ts",
							start: { line: 5, column: 10 },
							end: { line: 5, column: 20 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/src/test.ts");

			expect(result).toHaveLength(1);
			expect(result[0].severity).toBe("warning");
			expect(result[0].semantic).toBe("warning");
		});

		it("handles multiple diagnostics", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						category: "noUnusedVariables",
						message: "Unused variable",
						location: {
							source: "test.ts",
							start: { line: 1, column: 1 },
							end: { line: 1, column: 5 },
						},
					},
					{
						severity: "warning",
						category: "noConsole",
						message: "Do not use console",
						location: {
							source: "test.ts",
							start: { line: 2, column: 1 },
							end: { line: 2, column: 8 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/src/test.ts");

			expect(result).toHaveLength(2);
			expect(result[0].severity).toBe("error");
			expect(result[1].severity).toBe("warning");
		});

		it("handles empty diagnostics array", () => {
			const biomeOutput = JSON.stringify({ diagnostics: [] });
			const result = parseBiomeJson(biomeOutput, "/src/test.ts");
			expect(result).toHaveLength(0);
		});

		it("handles missing diagnostics field", () => {
			const biomeOutput = JSON.stringify({});
			const result = parseBiomeJson(biomeOutput, "/src/test.ts");
			expect(result).toHaveLength(0);
		});

		it("handles invalid JSON gracefully", () => {
			const result = parseBiomeJson("not valid json", "/src/test.ts");
			expect(result).toHaveLength(0);
		});

		it("maps all severity levels correctly", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						category: "e1",
						message: "Error",
						location: {
							source: "f",
							start: { line: 1, column: 1 },
							end: { line: 1, column: 1 },
						},
					},
					{
						severity: "warning",
						category: "w1",
						message: "Warning",
						location: {
							source: "f",
							start: { line: 2, column: 1 },
							end: { line: 2, column: 1 },
						},
					},
					{
						severity: "information",
						category: "i1",
						message: "Info",
						location: {
							source: "f",
							start: { line: 3, column: 1 },
							end: { line: 3, column: 1 },
						},
					},
					{
						severity: "hint",
						category: "h1",
						message: "Hint",
						location: {
							source: "f",
							start: { line: 4, column: 1 },
							end: { line: 4, column: 1 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/src/test.ts");

			expect(result).toHaveLength(4);
			expect(result[0].severity).toBe("error");
			expect(result[0].semantic).toBe("blocking");
			expect(result[1].severity).toBe("warning");
			expect(result[1].semantic).toBe("warning");
			// #1791: biome's "information" tier now survives as Diagnostic
			// severity "info", instead of being collapsed into "warning".
			expect(result[2].severity).toBe("info");
			expect(result[2].semantic).toBe("warning");
			// "hint" survives as-is; only "error" is a blocking semantic.
			expect(result[3].severity).toBe("hint");
			expect(result[3].semantic).toBe("warning");
		});

		it("keeps blocking classification error-only when info/hint tiers are present", () => {
			// #1791: reviving hint/info severity must not widen what blocks.
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "information",
						category: "i1",
						message: "Info",
						location: {
							source: "f",
							start: { line: 1, column: 1 },
							end: { line: 1, column: 1 },
						},
					},
					{
						severity: "hint",
						category: "h1",
						message: "Hint",
						location: {
							source: "f",
							start: { line: 2, column: 1 },
							end: { line: 2, column: 1 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/src/test.ts");

			expect(result.every((d) => d.semantic !== "blocking")).toBe(true);
		});

		it("uses correct id format", () => {
			const biomeOutput = JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						category: "noHardcodedCredentials",
						message: "Hardcoded credentials",
						location: {
							source: "config.ts",
							start: { line: 42, column: 15 },
							end: { line: 42, column: 30 },
						},
					},
				],
			});

			const result = parseBiomeJson(biomeOutput, "/project/config.ts");

			expect(result[0].id).toBe("biome:noHardcodedCredentials:42");
		});
	});

	describe("normalizeBiomeSeverity", () => {
		it("maps each of biome's four declared tiers independently", () => {
			// #1791: each branch asserted independently so deleting/merging any
			// one of them into the "warning" fallback reds this test.
			expect(normalizeBiomeSeverity("error")).toBe("error");
			expect(normalizeBiomeSeverity("warning")).toBe("warning");
			expect(normalizeBiomeSeverity("information")).toBe("info");
			expect(normalizeBiomeSeverity("hint")).toBe("hint");
		});

		it("falls back to warning for an unrecognized value", () => {
			expect(
				normalizeBiomeSeverity(undefined as unknown as "warning"),
			).toBe("warning");
		});
	});
});
