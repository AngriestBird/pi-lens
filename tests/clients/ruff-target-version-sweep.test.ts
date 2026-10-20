/**
 * #4638 ticket 02: pi-lens passes no syntax level to ruff. Ruff discovers
 * `target-version` from the project config, so a flag spelled anywhere in
 * `clients/` is either a second owner of that decision or a stale copy of one.
 *
 * The scan is fail-closed: a hit that matches no admitted site reds with its
 * file and line, an admission that matches nothing reds as stale, and the
 * surviving population is pinned exactly. The one admitted site is black's own
 * CLI shape in the bash guard, which is unrelated to ruff.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	listSourceFiles,
	readWalkedFile,
	relativePosix,
} from "../support/sweep-kit.js";

const ROOT = fileURLToPath(new URL("../../clients", import.meta.url));
const NEEDLE = "--target-version";

const ADMITTED: ReadonlyArray<{ file: string; reason: string }> = [
	{
		file: "bash-file-access.ts",
		reason:
			"black's CLI takes `--target-version <value>`; the bash guard must skip that value to find file operands, and pi-lens never passes the flag to black",
	},
];

interface Hit {
	file: string;
	line: number;
	text: string;
}

function scan(): Hit[] {
	const hits: Hit[] = [];
	for (const absolute of listSourceFiles(ROOT)) {
		const source = readWalkedFile(absolute);
		if (source === undefined) continue;
		const lines = source.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const text = lines[index] ?? "";
			if (!text.includes(NEEDLE)) continue;
			hits.push({ file: relativePosix(ROOT, absolute), line: index + 1, text });
		}
	}
	return hits;
}

describe("ruff syntax-level overrides stay out of clients/ (#4638)", () => {
	it("admits only black's CLI shape and no ruff invocation", () => {
		const hits = scan();

		const unadmitted = hits.filter(
			(hit) => !ADMITTED.some((entry) => entry.file === hit.file),
		);
		expect(
			unadmitted,
			`unclassified ${NEEDLE} site(s): ${JSON.stringify(unadmitted, null, 2)}`,
		).toEqual([]);

		const stale = ADMITTED.filter(
			(entry) => !hits.some((hit) => hit.file === entry.file),
		);
		expect(stale, "stale admission(s)").toEqual([]);

		// The population this ticket leaves behind, pinned exactly.
		expect(hits.map((hit) => `${hit.file}:${hit.line}`)).toEqual([
			"bash-file-access.ts:1058",
		]);
		expect(hits.some((hit) => hit.file === "ruff-client.ts")).toBe(false);
	});

	it("admits every surviving site with a stated reason", () => {
		for (const entry of ADMITTED) {
			expect(entry.reason.length).toBeGreaterThan(20);
		}
	});
});
