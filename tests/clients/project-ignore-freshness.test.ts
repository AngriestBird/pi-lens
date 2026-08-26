import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getProjectIgnoreMatcher,
	PROJECT_IGNORE_FRESHNESS_CADENCE_MS,
} from "../../clients/file-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("project ignore freshness probe (#2159)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("refreshes a consumed nested ignore file after an external edit", () => {
		const env = setupTestEnvironment("pi-lens-2159-external-");
		try {
			const nested = path.join(env.tmpDir, "ignored", "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			const target = path.join(nested, "generated.ts");
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "ignored/\n");
			fs.writeFileSync(ignorePath, "generated.ts\n");
			const first = getProjectIgnoreMatcher(env.tmpDir);
			expect(first.isIgnored(target)).toBe(true);
			// The next lookup publishes the nested source discovered by the verdict.
			expect(getProjectIgnoreMatcher(env.tmpDir)).toBe(first);

			// This bypasses the tool_result write boundary that #2153 covers.
			fs.writeFileSync(ignorePath, "!generated.ts\n");
			vi.useFakeTimers();
			vi.setSystemTime(Date.now() + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);

			expect(getProjectIgnoreMatcher(env.tmpDir).isIgnored(target)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("drops a consumed nested source when an external delete removes it", () => {
		const env = setupTestEnvironment("pi-lens-2159-delete-");
		try {
			const nested = path.join(env.tmpDir, "ignored", "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			const target = path.join(nested, "generated.ts");
			fs.writeFileSync(ignorePath, "generated.ts\n");
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(target)).toBe(true);
			getProjectIgnoreMatcher(env.tmpDir);
			fs.unlinkSync(ignorePath);
			vi.useFakeTimers();
			vi.setSystemTime(Date.now() + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);

			expect(getProjectIgnoreMatcher(env.tmpDir).isIgnored(target)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the unchanged matcher hot inside the cadence window", () => {
		const env = setupTestEnvironment("pi-lens-2159-cadence-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(nested, ".gitignore"), "generated.ts\n");
			const target = path.join(nested, "generated.ts");
			getProjectIgnoreMatcher(env.tmpDir).isIgnored(target);

			const first = getProjectIgnoreMatcher(env.tmpDir);
			expect(getProjectIgnoreMatcher(env.tmpDir)).toBe(first);
		} finally {
			env.cleanup();
		}
	});
});
