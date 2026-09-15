import { describe, expect, it } from "vitest";
import {
	detectIndentation,
	hasDetectableIndentation,
} from "../../../clients/dispatch/indent-detect.js";

describe("indentation detection", () => {
	it.each([
		["\tone\n\t\ttwo\n", { style: "tab", width: 1 }],
		["top\n  one\n    two\n", { style: "space", width: 2 }],
		["top\n   one\n", { style: "space", width: 3 }],
		[
			"top\n  shallow\n" + "      deep\n".repeat(10),
			{ style: "space", width: 2 },
		],
	])("detects %s", (content, expected) => {
		expect(detectIndentation(content)).toEqual(expected);
		expect(hasDetectableIndentation(content)).toBe(true);
	});

	it("infers the unit from aligned continuation runs", () => {
		// Regression: the shallowest run is continuation alignment, not the
		// formatter's unit (#3038, F-3039-1).
		const content =
			"const value = call(\n      first,\n      second,\n    );\n";
		expect(detectIndentation(content)).toEqual({ style: "space", width: 2 });
	});

	it.each([
		"      nested\n            deeper\n",
		"      nested\n      sibling\n",
	])("declines nested-only evidence: %s", (content) => {
		// Regression: a nested-only file cannot distinguish its first run from a
		// genuine indentation unit, so style pinning must be declined.
		expect(detectIndentation(content)).toBeUndefined();
		expect(hasDetectableIndentation(content)).toBe(true);
	});

	it("chooses the majority style in mixed content", () => {
		expect(detectIndentation("top\n  one\n    two\n\tthree\n")).toEqual({
			style: "space",
			width: 2,
		});
	});

	it.each(["", "const x = 1;\n"])("uses a safe default for %s", (content) => {
		expect(detectIndentation(content)).toEqual({ style: "space", width: 2 });
		expect(hasDetectableIndentation(content)).toBe(false);
	});
});
