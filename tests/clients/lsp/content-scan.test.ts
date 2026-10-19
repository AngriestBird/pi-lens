/**
 * `lineTextAt` moved here from `position-encoding.ts` (#2066): line addressing
 * of document content is one domain, owned by `clients/lsp/content-scan.ts`,
 * not by the position-encoding core that only consumes it.
 */

import { describe, expect, it } from "vitest";
import { lineTextAt } from "../../../clients/lsp/content-scan.js";

describe("lineTextAt (#269)", () => {
	it("returns the 0-based line text", () => {
		const content = "first\nsecond\nthird";
		expect(lineTextAt(content, 0)).toBe("first");
		expect(lineTextAt(content, 1)).toBe("second");
		expect(lineTextAt(content, 2)).toBe("third");
	});

	it("returns empty string for out-of-range lines", () => {
		expect(lineTextAt("only", 5)).toBe("");
		expect(lineTextAt("only", -1)).toBe("");
	});
});
