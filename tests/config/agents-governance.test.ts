import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function agentsText(): string {
	return fs.readFileSync(
		process.env.PI_LENS_AGENTS_PATH ?? path.join(REPO_ROOT, "AGENTS.md"),
		"utf8",
	);
}

describe("AGENTS.md trigger-block governance (#3259)", () => {
	it("gives every important block one unique non-empty trigger", () => {
		const triggers = [...agentsText().matchAll(/^<important if="([^"]*)">$/gm)].map(
			(match) => match[1].trim(),
		);
		expect(triggers.length).toBeGreaterThan(0);
		expect(triggers.every(Boolean)).toBe(true);
		expect(new Set(triggers).size).toBe(triggers.length);
	});

	it("keeps every numbered defect shape exactly once", () => {
		const numbers = [...agentsText().matchAll(/^(\d+)\. \*\*/gm)].map((match) =>
			Number(match[1]),
		);
		expect(numbers).toHaveLength(52);
		expect(new Set(numbers).size).toBe(52);
		expect(numbers.sort((a, b) => a - b)).toEqual(
			Array.from({ length: 52 }, (_, index) => index + 1),
		);
	});
});
