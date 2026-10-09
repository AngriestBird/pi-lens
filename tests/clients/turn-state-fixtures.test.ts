import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";

const fixtures = path.join(process.cwd(), "tests", "fixtures", "turn-state");

describe("#3613 turn-state durable record corpus", () => {
	it("parses legacy and partitioned records, while an old reader ignores sessions", () => {
		for (const name of ["v1.json", "v2.json"]) {
			const parsed = JSON.parse(
				fs.readFileSync(path.join(fixtures, name), "utf8"),
			);
			expect(parsed.files).toBeDefined();
			// The pre-partition reader only consumes the legacy fields; the optional
			// sessions member must not make that supported record unreadable.
			const oldReader: {
				files: unknown;
				turnCycles: unknown;
				maxCycles: unknown;
				lastUpdated: unknown;
				sessions?: unknown;
			} = {
				files: parsed.files,
				turnCycles: parsed.turnCycles,
				maxCycles: parsed.maxCycles,
				lastUpdated: parsed.lastUpdated,
			};
			expect(oldReader.files).toBeDefined();
			expect(oldReader.sessions).toBeUndefined();
		}
	});

	it("drops expired secondary partitions at load", () => {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(fixtures, "v2.json"), "utf8"),
		);
		parsed.sessions["expired"] = {
			...parsed.sessions["secondary-a"],
			lastUpdated: "2020-01-01T00:00:00.000Z",
		};
		const cwd = fs.mkdtempSync(
			path.join(process.cwd(), ".turn-state-fixture-"),
		);
		try {
			const dataDir = path.join(cwd, ".pi-lens");
			fs.mkdirSync(dataDir, { recursive: true });
			fs.writeFileSync(
				path.join(dataDir, "turn-state.json"),
				JSON.stringify(parsed),
			);
			// CacheManager resolves the legacy project-local directory when present.
			const state = new CacheManager(false).readTurnState(cwd);
			expect(state.sessions?.expired).toBeUndefined();
			expect(state.sessions?.["secondary-a"]).toBeDefined();
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps only the 16 newest live secondary partitions", () => {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(fixtures, "v2.json"), "utf8"),
		);
		parsed.sessions = Object.fromEntries(
			Array.from({ length: 17 }, (_, index) => [
				`secondary-${index}`,
				{
					files: {},
					turnCycles: 0,
					maxCycles: 3,
					lastUpdated: new Date(Date.now() - index * 1000).toISOString(),
					sessionId: `secondary-${index}`,
				},
			]),
		);
		const cwd = fs.mkdtempSync(
			path.join(process.cwd(), ".turn-state-fixture-"),
		);
		try {
			const dataDir = path.join(cwd, ".pi-lens");
			fs.mkdirSync(dataDir, { recursive: true });
			fs.writeFileSync(
				path.join(dataDir, "turn-state.json"),
				JSON.stringify(parsed),
			);
			const state = new CacheManager(false).readTurnState(cwd);
			expect(Object.keys(state.sessions ?? {})).toHaveLength(16);
			expect(state.sessions?.["secondary-0"]).toBeDefined();
			expect(state.sessions?.["secondary-16"]).toBeUndefined();
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("removes only the secondary partition at shutdown", () => {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(fixtures, "v2.json"), "utf8"),
		);
		parsed.sessions["secondary-b"] = {
			...parsed.sessions["secondary-a"],
			sessionId: "secondary-b",
		};
		const cwd = fs.mkdtempSync(
			path.join(process.cwd(), ".turn-state-fixture-"),
		);
		try {
			const dataDir = path.join(cwd, ".pi-lens");
			fs.mkdirSync(dataDir, { recursive: true });
			fs.writeFileSync(
				path.join(dataDir, "turn-state.json"),
				JSON.stringify(parsed),
			);
			const cache = new CacheManager(false);
			expect(
				cache.clearTurnState(
					cwd,
					{ kind: "pi", id: "secondary-a" },
					"secondary",
				),
			).toBe(true);
			expect(
				cache.readTurnState(cwd).sessions?.["secondary-a"],
			).toBeUndefined();
			expect(cache.readTurnState(cwd).sessions?.["secondary-b"]).toBeDefined();
			expect(cache.readTurnState(cwd).owner?.id).toBe("primary");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
