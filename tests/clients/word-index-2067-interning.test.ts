import { describe, expect, it, vi } from "vitest";

const { normalizeCalls } = vi.hoisted(() => ({ normalizeCalls: { value: 0 } }));
vi.mock("../../clients/path-utils.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/path-utils.js")>();
	return {
		...actual,
		normalizeEphemeralMapKey: (file: string) => {
			normalizeCalls.value += 1;
			return actual.normalizeEphemeralMapKey(file);
		},
	};
});

describe("word-index posting file interning (#2067)", () => {
	it("keeps removal normalization proportional to distinct files, not hits", async () => {
		const { buildWordIndex, removeWordIndexDocument, searchWordIndex } =
			await import("../../clients/word-index.js");
		const files = Array.from({ length: 40 }, (_, i) => ({
			path: `doc-${i}.ts`,
			content: Array.from({ length: 40 }, () => "sharedToken").join("\n"),
		}));
		const index = buildWordIndex(files);

		normalizeCalls.value = 0;
		expect(removeWordIndexDocument(index, "doc-0.ts")).toBe(true);

		// The old filter normalized all 1,600 posting elements. A small fixed
		// bound allows map housekeeping while proving the hot loop is gone.
		expect(normalizeCalls.value).toBeLessThan(100);
		expect(searchWordIndex(index, "sharedToken")).toHaveLength(20);
	});
});
