import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const SELF = "tests/config/sweep-floor-coverage.test.ts";

/**
 * Sweep shape: a test file with a production/source-scan marker and an
 * empty-array assertion. The marker list names the established governance
 * seams (plus the kit's two floor APIs), rather than matching every ordinary
 * unit test that happens to assert `[]`. This targets registered-or-fail
 * scans, where a dead population is otherwise indistinguishable from clean.
 * The source walk uses the kit so this meta-sweep has its own scan and match
 * floors, and every exception is a named, reasoned registration.
 */
function sweepShapeFiles(): string[] {
	return listSourceFiles(TESTS_ROOT, { extensions: [".ts"] })
		.filter((file) => file.endsWith(".test.ts"))
		.filter((file) => relativePosix(REPO_ROOT, file) !== SELF)
		.filter((file) => {
			const raw = fs.readFileSync(file, "utf8");
			const source = stripSource(raw);
			const namedSweep =
				/(?:assertNonEmptyScan|auditRegistry|scanDualInstanceImports|LSP_SERVERS|LSP_FIXTURES|ALL_FORMATTERS|DYNAMIC_OR_EXEMPT|isTimingSensitive|scanHostEventShapeViolations)/.test(
					source,
				);
			const freshnessSweep =
				file.endsWith("/freshness-sweep.test.ts") && /\.mtimeMs/.test(source);
			return (
				/\.toEqual\(\s*\[\s*\]\s*\)/.test(source) &&
				(namedSweep || freshnessSweep)
			);
		});
}

const DECLARED_EXCEPTIONS: Readonly<Record<string, string>> = {
	"tests/clients/dispatch/format-smoke-style-contract.test.ts":
		"contract fixture assertions, not a registered-or-fail source population sweep",
	"tests/clients/formatter-probe-commands.test.ts":
		"direct formatter probe behavior tests; the formatter registry sweep is formatter-policy-consistency",
	"tests/clients/language-policy.test.ts":
		"policy unit cases over synthetic language definitions, not a production walk",
	"tests/clients/lsp/lsp-primary-reachability.test.ts":
		"synthetic candidate-routing behavior tests; server population coverage is lsp-fixture-coverage",
	"tests/clients/lsp/lsp-registry-consistency.test.ts":
		"registry relation assertions without a blindable source walk",
	"tests/clients/lsp/server-policy.test.ts":
		"server policy behavior cases, not the LSP fixture population sweep",
};

describe("registered-or-fail sweep floors", () => {
	it("every sweep-shaped test uses sweep-kit or declares a reason", () => {
		const files = sweepShapeFiles().map((file) =>
			relativePosix(REPO_ROOT, file),
		);
		const registered = files.filter((file) => {
			const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
			return /from\s+["'][^"']*(?:support[\\/]sweep-kit|[./]sweep-kit)(?:\.js|\.ts)?["']/.test(
				source,
			);
		});
		const audit = auditRegistry({
			sweepName: "sweep-floor meta-sweep",
			flagged: files,
			registered,
			exemptions: DECLARED_EXCEPTIONS,
			scannedCount: files.length,
			minScanned: 1,
			minFlagged: 1,
			minReasonLength: 20,
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});
});
