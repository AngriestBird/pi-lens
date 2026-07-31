import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYZER_IDS } from "../../../clients/project-diagnostics/fresh-fetch.js";

/**
 * #585 / #1004-class guardrail.
 *
 * Both #585 (opengrep) and #1004 (test-runner) were the SAME bug shape: an
 * analyzer had a real cache writer (session-start's `runHeavyweightTask`
 * wrapper in `runtime-session.ts`, or turn_end's dedicated test-fire in
 * `runtime-turn.ts`) that scanned and cached findings, while
 * `fetchFreshProjectDiagnostics`'s `ANALYZER_IDS` (the single source of truth
 * for `lens_diagnostics mode=full`, #883) silently omitted the id — so the
 * findings were real, cached, and never read back.
 *
 * Rather than hand-maintain a second list of "ids that should be in
 * ANALYZER_IDS" (the exact parallel-list anti-pattern that caused #585 in the
 * first place), this test greps the actual writer call sites in production
 * source and asserts every id found there is a member of `ANALYZER_IDS`. A
 * future analyzer wired into either writer without an `ANALYZER_IDS` entry
 * fails this test instead of silently shipping an orphaned scan-and-cache
 * path.
 */

const repoRoot = path.resolve(__dirname, "../../..");

function readSource(relPath: string): string {
	return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

describe("mode=full analyzer coverage guardrail (#585, #1004)", () => {
	it("every session-start runHeavyweightTask id is a member of ANALYZER_IDS", () => {
		const source = readSource("clients/runtime-session.ts");
		const ids = [...source.matchAll(/runHeavyweightTask\(\s*"([^"]+)"/g)].map(
			(m) => m[1],
		);

		// Sanity check the regex itself still finds something — an empty match
		// list would make the assertion below vacuously true if `runtime-session.ts`
		// ever gets refactored to call the wrapper differently.
		expect(ids.length).toBeGreaterThan(0);

		for (const id of ids) {
			expect(ANALYZER_IDS as readonly string[]).toContain(id);
		}
	});

	it("the turn_end test-runner-findings cache writer is covered by ANALYZER_IDS's test-runner entry (#1004)", () => {
		const source = readSource("clients/runtime-turn.ts");

		// Sanity check the writer this guardrail is protecting still exists under
		// the expected cache key — if it's ever renamed, this test should be
		// updated deliberately rather than silently pass.
		expect(source).toContain('"test-runner-findings"');
		expect(ANALYZER_IDS as readonly string[]).toContain("test-runner");
	});
});
