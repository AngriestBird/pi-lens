import { describe, expect, it } from "vitest";
import { KIND_EXTENSIONS } from "../../clients/file-kinds.js";
import {
	SUPPORTED_FILE_KINDS,
	WARMUP_SOURCE_EXTS,
} from "../../clients/language-profile.js";
import { ALL_SCANNABLE_EXTENSIONS } from "../../clients/source-filter.js";

describe("project-wide extension coverage (#894)", () => {
	const scannable = new Set(ALL_SCANNABLE_EXTENSIONS);

	it("derives supported kinds from every KIND_EXTENSIONS key", () => {
		expect(new Set(SUPPORTED_FILE_KINDS)).toEqual(
			new Set(Object.keys(KIND_EXTENSIONS)),
		);
	});

	it.each(Object.entries(KIND_EXTENSIONS))(
		"includes every %s extension in shared source enumeration",
		(_kind, extensions) => {
			for (const extension of extensions) {
				expect(scannable.has(extension)).toBe(true);
			}
		},
	);

	it.each(Object.entries(KIND_EXTENSIONS))(
		"includes every %s extension in language-profile warmup",
		(_kind, extensions) => {
			for (const extension of extensions) {
				expect(WARMUP_SOURCE_EXTS.has(extension)).toBe(true);
			}
		},
	);
});
