// #1718: the self-scan (scripts/run-astgrep-pi-lens.mjs) used to hardcode a
// single author's nonexistent machine paths as both scan target and rule
// source, so it silently scanned nothing in CI, ever. This is the
// registered-or-fail guard: it runs the REAL scan mechanism (the same
// scripts/lib/astgrep-self-scan.mjs the CLI wrapper uses) against a
// synthetic violation, independent of what pi-lens's own tree currently
// contains, so a future regression that makes the scan a no-op again fails
// HERE instead of dying silently a second time.
//
// The CLI is opt-in, mirroring ast-grep-catalog-rules.test.ts: if `ast-grep`
// is not on PATH the whole describe is skipped. `npm test`/`npm run` put
// node_modules/.bin on PATH, which is how the CLI resolves in CI and locally
// without a global install.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeSpawn } from "../../clients/safe-spawn.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import {
	findingSignature,
	loadBaseline,
	repoRoot,
	runSelfScan,
	selfScanRuleIds,
} from "../../scripts/lib/astgrep-self-scan.mjs";

function probeCli(): boolean {
	const result = safeSpawn("ast-grep", ["--version"]);
	return result.status === 0 && !result.error;
}

const cliAvailable = probeCli();
const d = cliAvailable ? describe : describe.skip;

// #448-style CI-loud guard: a describe.skip on a missing CLI must not vanish
// silently in CI.
it("ast-grep CLI is installed in CI", () => {
	if (process.env.CI) expect(cliAvailable).toBe(true);
});

d("pi-lens self-scan (#1718)", () => {
	it("at least one rule is tagged category: pi-lens-self-scan", () => {
		// A guard against the tag silently disappearing (e.g. a rule file
		// rewrite that drops the field): an empty rule set is a hard error
		// from runSelfScan, but this pins the count as a mutation-proof
		// symptom check independent of that throw.
		expect(selfScanRuleIds().length).toBeGreaterThan(0);
	});

	it("clients/ + tests/ scan has no untriaged finding", () => {
		const result = runSelfScan();
		const baseline = loadBaseline();
		const untriaged = result.findings.filter(
			(f) => !baseline.has(findingSignature(f)),
		);
		expect(
			untriaged,
			JSON.stringify(untriaged, null, 2),
		).toEqual([]);
	});

	it("scans a nonzero file count (a dead scan must not read as clean)", () => {
		const result = runSelfScan();
		expect(result.scannedFileCount).toBeGreaterThan(0);
	});

	// ── Mutation-proof probe: the scan itself must actually CATCH the shape
	// it claims to, on synthetic source outside pi-lens's own tree, so this
	// keeps failing even on a day pi-lens's own code happens to be clean. ──
	it("flags a synthetic no-raw-json-store-write violation outside the repo tree", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-selfscan-"));
		try {
			fs.writeFileSync(
				path.join(dir, "violation.ts"),
				[
					'import { writeFileSync } from "node:fs";',
					"function f(file: string, data: unknown) {",
					"  writeFileSync(file, JSON.stringify(data));",
					"}",
					"",
				].join("\n"),
				"utf-8",
			);
			const result = runSelfScan({
				root: repoRoot(),
				scanPaths: [dir],
				ruleIds: ["no-raw-json-store-write"],
			});
			expect(result.scannedFileCount).toBe(1);
			expect(result.findings.length).toBeGreaterThan(0);
			expect(result.findings[0]?.ruleId).toBe("no-raw-json-store-write");
		} finally {
			removeTempDirSync(dir);
		}
	});

	it("does not flag the atomic-write seam itself on the same synthetic snippet, negative control", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-selfscan-"));
		try {
			fs.writeFileSync(
				path.join(dir, "clean.ts"),
				[
					'import { writeFileAtomic } from "./atomic-write.js";',
					"function f(file: string, data: unknown) {",
					"  writeFileAtomic(file, JSON.stringify(data));",
					"}",
					"",
				].join("\n"),
				"utf-8",
			);
			const result = runSelfScan({
				root: repoRoot(),
				scanPaths: [dir],
				ruleIds: ["no-raw-json-store-write"],
			});
			expect(result.findings).toEqual([]);
		} finally {
			removeTempDirSync(dir);
		}
	});

	it("throws (never reads as a clean 0-finding scan) when ruleIds resolves empty", () => {
		expect(() => runSelfScan({ ruleIds: [] })).toThrow(/nothing to run/);
	});
});
