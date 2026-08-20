import { describe, expect, it } from "vitest";
import {
	normalizePyrightSeverity,
	parsePyrightOutput,
} from "../../../../clients/dispatch/runners/pyright.js";

/**
 * #1802: pyright's `--outputjson` output declares three severities on
 * `generalDiagnostics[].severity` — "error", "warning", "information" — but
 * the runner collapsed "information" into "warning", the same defect shape
 * #1787 fixed for ast-grep-napi and #1791 fixed for biome-check. These tests
 * import the REAL `parsePyrightOutput`/`normalizePyrightSeverity` from the
 * compiled runner (not an inlined copy) so the mapping can't drift silently
 * out of sync with what's shipped.
 */
describe("normalizePyrightSeverity", () => {
	it("maps information to info", () => {
		expect(normalizePyrightSeverity("information")).toBe("info");
	});

	it("passes error and warning through unchanged", () => {
		expect(normalizePyrightSeverity("error")).toBe("error");
		expect(normalizePyrightSeverity("warning")).toBe("warning");
	});

	it("falls back to warning for an unrecognized value", () => {
		expect(normalizePyrightSeverity(undefined)).toBe("warning");
		expect(normalizePyrightSeverity("bogus" as never)).toBe("warning");
	});
});

describe("parsePyrightOutput", () => {
	function makeData(severity: string) {
		return {
			generalDiagnostics: [
				{
					severity,
					message: "example diagnostic",
					file: "/proj/example.py",
					rule: "reportExample",
					start: { line: 3, column: 5 },
				},
			],
		};
	}

	it("preserves pyright's information tier as info, not warning", () => {
		const diags = parsePyrightOutput(
			makeData("information"),
			"/proj/example.py",
		);
		expect(diags).toHaveLength(1);
		expect(diags[0].severity).toBe("info");
		// Non-error severities stay non-blocking.
		expect(diags[0].semantic).toBe("warning");
	});

	it("keeps error diagnostics blocking", () => {
		const diags = parsePyrightOutput(makeData("error"), "/proj/example.py");
		expect(diags[0].severity).toBe("error");
		expect(diags[0].semantic).toBe("blocking");
	});

	it("keeps warning diagnostics as warning/non-blocking", () => {
		const diags = parsePyrightOutput(makeData("warning"), "/proj/example.py");
		expect(diags[0].severity).toBe("warning");
		expect(diags[0].semantic).toBe("warning");
	});

	it("never widens blocking classification for the info tier", () => {
		const diags = parsePyrightOutput(
			makeData("information"),
			"/proj/example.py",
		);
		// Mutation guard: an info-tier diagnostic must stay non-blocking even
		// though its severity display tier changed.
		expect(diags[0].semantic).not.toBe("blocking");
	});
});
