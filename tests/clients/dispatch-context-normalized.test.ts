import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDispatchContext } from "../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

/**
 * #2016. Two halves of one invariant.
 *
 * Half one: `createDispatchContext` normalizes `filePath`, `cwd`, and
 * `projectRoot`, so re-normalizing them downstream is a pure syscall.
 *
 * Half two: no call site re-normalizes them. That half is a source scan,
 * because the waste is invisible to a behavioral assertion: on POSIX the
 * redundant call short-circuits and returns the same string, so a value test
 * passes either way. Only the source can tell the difference on CI.
 */
describe("dispatch context normalization invariant (#2016)", () => {
	it("normalizes filePath, cwd, and projectRoot at construction", () => {
		const env = setupTestEnvironment("pi-lens-2016-ctx-");
		try {
			const target = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			const pi = {
				getFlag: () => undefined,
			} as unknown as Parameters<typeof createDispatchContext>[2];

			const ctx = createDispatchContext(
				target,
				env.tmpDir,
				pi,
				new FactStore(),
				false,
				undefined,
				env.tmpDir,
			);

			// Idempotence is the property the call sites rely on: normalizing an
			// already-normalized value must be a no-op, or dropping the redundant
			// call would change a key.
			expect(normalizeMapKey(ctx.filePath)).toBe(ctx.filePath);
			expect(normalizeMapKey(ctx.cwd)).toBe(ctx.cwd);
			expect(ctx.projectRoot).toBeDefined();
			expect(normalizeMapKey(ctx.projectRoot as string)).toBe(ctx.projectRoot);
		} finally {
			env.cleanup();
		}
		// Generous budget: this drives the real constructor, which loads project
		// config and reads a file prefix. Under a loaded parallel run the default
		// 5s budget is a flake, not a signal.
	}, 30_000);

	it("has no call site that re-normalizes an already-normalized context field", () => {
		const repoRoot = path.resolve(import.meta.dirname, "..", "..");
		const roots = ["clients", "tools", "mcp", "index.ts"];
		const offenders: string[] = [];
		// `ctx`, `context`, and `dispatchContext` are the spellings the dispatch
		// seam uses for a DispatchContext. Matching the receiver rather than a
		// bare field name keeps this from firing on unrelated `filePath` locals.
		const pattern =
			/normalizeMapKey\(\s*(?:ctx|context|dispatchContext)\.(?:filePath|cwd|projectRoot)\b/;

		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "node_modules" || entry.name === "deps") continue;
					walk(full);
					continue;
				}
				if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts"))
					continue;
				const lines = fs.readFileSync(full, "utf-8").split(/\r?\n/);
				lines.forEach((line, index) => {
					// Comments name the forbidden form in order to forbid it.
					const trimmed = line.trim();
					if (
						trimmed.startsWith("*") ||
						trimmed.startsWith("//") ||
						trimmed.startsWith("/*")
					)
						return;
					if (pattern.test(line)) {
						const relative = path
							.relative(repoRoot, full)
							.split(path.sep)
							.join("/");
						offenders.push(`${relative}:${index + 1}`);
					}
				});
			}
		};

		for (const root of roots) {
			const full = path.join(repoRoot, root);
			if (!fs.existsSync(full)) continue;
			if (fs.statSync(full).isDirectory()) walk(full);
			else if (pattern.test(fs.readFileSync(full, "utf-8")))
				offenders.push(root);
		}

		expect(offenders).toEqual([]);
	});
});
