/**
 * #2281 — every latency-logger mock must preserve the real export surface.
 *
 * A bare factory replacement hides exports added after the test was written.
 * This guard derives its inventory from every test source and checks only the
 * factory body, so an unrelated importActual cannot satisfy the check.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../support/module-instance-scan.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";

/** Every `*.test.ts` under `root`, through the shared walker (#3082): this
 *  file used to hand-roll the identical recursive `readdirSync` walk. */
function walkTestFiles(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	return listSourceFiles(root, { extensions: [".ts"] }).filter((file) =>
		file.endsWith(".test.ts"),
	);
}

type LatencyMock = { relativePath: string; factory: string };

function callEnd(source: string, openParen: number): number {
	let depth = 0;
	let quote = "";
	for (let index = openParen; index < source.length; index += 1) {
		const character = source[index];
		if (quote) {
			if (character === "\\") index += 1;
			else if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "(") depth += 1;
		if (character === ")" && --depth === 0) return index;
	}
	throw new Error(`Unclosed vi.mock call in ${source.slice(0, openParen)}`);
}

function findLatencyMocks({
	file,
	source,
}: {
	file: string;
	source: string;
}): LatencyMock[] {
	const code = stripSource(source);
	const mocks: LatencyMock[] = [];
	const pattern = /vi\.mock\s*\(/g;
	for (const match of code.matchAll(pattern)) {
		const start = match.index ?? 0;
		const header = source
			.slice(start)
			.match(/^vi\.mock\s*\(\s*(["'])([^"']*latency-logger[^"']*)\1\s*,/);
		if (!header) continue;
		const openParen = source.indexOf("(", start);
		const end = callEnd(source, openParen);
		mocks.push({
			relativePath: path.relative(repoRoot, file).replaceAll("\\", "/"),
			factory: source.slice(start + header[0].length, end),
		});
	}
	return mocks;
}

describe("latency-logger mock shape (#2281)", () => {
	it("derives every factory and requires a partial import", () => {
		// Recurrence guard for #2272 and #2281: comments and strings must not
		// excuse or trigger a code-only latency-logger mock scan.
		// Floors against 1,098 `.test.ts` files and ~114 latency-mocking files
		// at authoring time: well below live counts so normal growth never
		// trips them, but a silently dropped directory does. The population is
		// `tests/` source, which routine processes (e.g. the 4.1.4
		// `.changelog/` roll) never delete.
		const files = walkTestFiles(path.join(repoRoot, "tests"));
		assertNonEmptyScan("latency-logger test file walk", files.length, 900);
		// readWalkedFiles: a path that vanished between the walk and the read is
		// out of the population, not a finding (#3082 — this scan was one of the
		// four rotating ENOENT victims).
		const mocks = readWalkedFiles(files).flatMap(findLatencyMocks);
		assertNonEmptyScan("latency-logger mock scan", mocks.length, 80);
		const bare = mocks.filter(
			({ factory }) =>
				!factory.includes("importActual") &&
				!factory.includes("importOriginal"),
		);
		expect(bare).toEqual([]);
	});
});
