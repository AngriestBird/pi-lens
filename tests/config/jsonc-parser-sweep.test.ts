/**
 * #4638 F8: the tree has ONE JSONC reader. `clients/review-graph/tsconfig-paths.ts`
 * owns `parseJsonc` (comments and trailing commas, string-aware), and every
 * consumer — tsconfig discovery, pyright's `pythonVersion` — asks it. A second
 * stripper would answer the same question twice, which is exactly the fork this
 * sweep exists to keep deleted.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ROOTS = ["clients", "tools"].map((dir) => path.join(REPO_ROOT, dir));
const DEFINITION = /\bfunction\s+parseJsonc\s*[<(]/;
const EXPORTED_DEFINITION = /\bexport\s+function\s+parseJsonc\s*[<(]/;
const SECOND_READER = /\bstripJsonc\w*|\bskipJsonc\w*/;

interface LineHit {
	file: string;
	line: number;
	text: string;
}

function scan(pattern: RegExp): LineHit[] {
	const hits: LineHit[] = [];
	for (const root of ROOTS) {
		for (const absolute of listSourceFiles(root)) {
			const source = readWalkedFile(absolute);
			if (source === undefined) continue;
			// Comments and strings blanked: only real code can match, so a doc
			// comment naming the helper is not a second implementation.
			const scanned = stripSource(source).split("\n");
			for (let index = 0; index < scanned.length; index += 1) {
				const text = scanned[index] ?? "";
				if (!pattern.test(text)) continue;
				hits.push({
					file: relativePosix(REPO_ROOT, absolute),
					line: index + 1,
					text: text.trim(),
				});
			}
		}
	}
	return hits;
}

describe("the JSONC reader has one owner (#4638 F8)", () => {
	it("defines parseJsonc exactly once, exported, and no second stripper", () => {
		const scannedFiles = ROOTS.flatMap((root) => listSourceFiles(root));
		assertNonEmptyScan(
			"JSONC reader sweep (clients + tools)",
			scannedFiles.length,
			50,
		);

		expect(scan(DEFINITION).map((hit) => hit.file)).toEqual([
			"clients/review-graph/tsconfig-paths.ts",
		]);
		expect(scan(EXPORTED_DEFINITION).map((hit) => hit.file)).toEqual([
			"clients/review-graph/tsconfig-paths.ts",
		]);
		expect(scan(SECOND_READER)).toEqual([]);
	});
});
