import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	buildWordIndexAsync,
	serializeWordIndex,
} from "../../clients/word-index.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";

function makeDocs(count: number, linesPerFile: number) {
	return Object.assign(
		Array.from({ length: count }, (_, file) => ({
			path: `src/file-${file}.ts`,
			content: Array.from(
				{ length: linesPerFile },
				(_, line) =>
					`export function handler${file}_${line}(value: string) { return value.length + ${line}; }`,
			).join("\n"),
			mtimeMs: file + 1,
			size: file + 100,
		})),
		{ truncated: true },
	);
}

describe("cooperative word-index full build (#1197)", () => {
	it("is byte-equivalent to the synchronous reference builder", async () => {
		const docs = makeDocs(40, 25);

		const expected = serializeWordIndex(buildWordIndex(docs));
		const actual = serializeWordIndex(await buildWordIndexAsync(docs));

		expect(actual).toEqual(expected);
	});

	it("keeps scaled full-build event-loop occupancy bounded", {
		retry: 2,
		timeout: 30_000,
	}, async () => {
		const docs = makeDocs(1_000, 100);

		const maxBlockMs = await measureMaxSyncBlockMs(() =>
			buildWordIndexAsync(docs),
		);

		expect(maxBlockMs).toBeLessThan(300);
	});

	it("aborts a superseded build without returning a partial index", async () => {
		const docs = makeDocs(100, 100);
		let current = true;
		setImmediate(() => {
			current = false;
		});

		await expect(buildWordIndexAsync(docs, () => current)).rejects.toThrow(
			"word index build superseded",
		);
	});
});
