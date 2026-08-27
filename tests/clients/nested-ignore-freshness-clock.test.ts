import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

import {
	getProjectIgnoreMatcher,
	PROJECT_IGNORE_FRESHNESS_CADENCE_MS,
} from "../../clients/file-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("nested ignore freshness clock (#2071)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("keeps two paths under one nested rule in agreement after an external edit", () => {
		const env = setupTestEnvironment("pi-lens-2071-divergence-");
		try {
			const nested = path.join(env.tmpDir, "sub");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "node_modules\n");
			fs.writeFileSync(path.join(nested, ".gitignore"), "placeholder-keep\n");
			const memoized = path.join(nested, "x.ts");
			const fresh = path.join(nested, "y.ts");

			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(memoized)).toBe(false);

			// External edit, no pi-lens write hook: the IDE-edit shape.
			fs.writeFileSync(path.join(nested, ".gitignore"), "*.ts\n");

			// Same matcher, same directory, same rule. Before the shared clock the
			// fresh path re-read the nested rules while the memoized path replayed
			// its pre-edit verdict, so these two disagreed.
			expect(matcher.isIgnored(fresh)).toBe(matcher.isIgnored(memoized));
		} finally {
			env.cleanup();
		}
	});

	it("drops subtree verdicts when a walk rebuilds drifted nested patterns", () => {
		const env = setupTestEnvironment("pi-lens-2071-drift-drop-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "a.ts\n");
			const memoized = path.join(nested, "a.ts");
			const walked = path.join(nested, "b.ts");

			vi.useFakeTimers();
			const start = Date.now();
			// Held once, as a walk loop holds it. No further getProjectIgnoreMatcher
			// lookups, so the #2159 sweep cannot be what fixes this.
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(memoized)).toBe(true);

			fs.writeFileSync(ignorePath, "!a.ts\n");
			vi.setSystemTime(start + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);

			// This fresh path rebuilds the drifted directory. That rebuild must take
			// the superseded verdicts with it.
			matcher.isIgnored(walked);

			expect(matcher.isIgnored(memoized)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("stats a nested ignore source once per cadence window, not once per file", () => {
		const env = setupTestEnvironment("pi-lens-2071-bounded-cost-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "generated.ts\n");

			vi.useFakeTimers();
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			// First lookup builds the entry and arms the clock.
			matcher.isIgnored(path.join(nested, "seed.ts"));

			const statSpy = vi.spyOn(fs, "statSync");
			const sourceStats = () =>
				statSpy.mock.calls.filter(([filePath]) => filePath === ignorePath)
					.length;
			statSpy.mockClear();

			// Fifty distinct paths in one directory, all inside one window.
			for (let index = 0; index < 50; index++) {
				matcher.isIgnored(path.join(nested, `f${index}.ts`));
			}

			expect(sourceStats()).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it("reads the nested ignore source once per check instead of twice", () => {
		const env = setupTestEnvironment("pi-lens-2071-single-stat-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			fs.writeFileSync(ignorePath, "generated.ts\n");

			const statSpy = vi.spyOn(fs, "statSync");
			const sourceStats = () =>
				statSpy.mock.calls.filter(([filePath]) => filePath === ignorePath)
					.length;
			statSpy.mockClear();

			// One cold lookup: one freshness check of this one nested source.
			getProjectIgnoreMatcher(env.tmpDir).isIgnored(
				path.join(nested, "generated.ts"),
			);

			expect(sourceStats()).toBe(1);
		} finally {
			env.cleanup();
		}
	});
});
