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
 * Sweep shape requires both an enumeration and an emptiness assertion. The
 * production-symbol list remains an intent exception for registries whose
 * walk is not syntactically obvious. Static detection is evadable by
 * construction; this catches natural shapes, while the exception list catches
 * intent.
 */
function sweepShapeFiles(): string[] {
	return listSourceFiles(TESTS_ROOT, { extensions: [".ts"] })
		.filter((file) => file.endsWith(".test.ts"))
		.filter((file) => relativePosix(REPO_ROOT, file) !== SELF)
		.filter((file) => {
			const raw = fs.readFileSync(file, "utf8");
			const source = stripSource(raw);
			const enumerates =
				/(?:fs\.readdirSync|(?<![A-Za-z0-9_$])readdirSync|fs\.promises\.readdir|globSync|listSourceFiles|clientSourceFiles)/.test(
					source,
				) ||
				/(?:assertNonEmptyScan|auditRegistry|scanDualInstanceImports|LSP_SERVERS|LSP_FIXTURES|ALL_FORMATTERS|DYNAMIC_OR_EXEMPT|isTimingSensitive|scanHostEventShapeViolations)/.test(
					source,
				);
			const empties =
				/\.toEqual\(\s*\[\s*\]\s*\)|\.toHaveLength\(\s*0\s*\)|\.toStrictEqual\(\s*\[\s*\]\s*\)/.test(
					source,
				);
			return enumerates && empties;
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
	"tests/clients/ast-grep-rule-precedence-followups.test.ts":
		"rule precedence fixtures, not a production population sweep",
	"tests/clients/atomic-write.test.ts":
		"atomic-write behavior cases, not a production population sweep",
	"tests/clients/bus-producer-coverage.test.ts":
		"bus contract cases, not a registered-or-fail population sweep",
	"tests/clients/coderabbit-ast-grep-rules.test.ts":
		"rule fixtures, not a production population sweep",
	"tests/clients/debug-heap.test.ts":
		"heap diagnostic cases, not a production population sweep",
	"tests/clients/delivery-surface-ratchet.test.ts":
		"delivery fixtures, not a production population sweep",
	"tests/clients/deps-centralization.test.ts":
		"dependency relation cases, not a production population sweep",
	"tests/clients/diagnostic-dispositions.test.ts":
		"disposition cases, not a production population sweep",
	"tests/clients/dispatch/dispatch-coverage.test.ts":
		"dispatch relation cases; its stale-entry check is not a population sweep",
	"tests/clients/dispatch/runners/ast-grep-rule-tests.test.ts":
		"rule fixtures, not a production population sweep",
	"tests/clients/dispatch/runners/ast-grep-rule-validity.test.ts":
		"rule fixtures, not a production population sweep",
	"tests/clients/dispatch/runners/ast-grep-tsx-coverage.test.ts":
		"rule fixtures, not a production population sweep",
	"tests/clients/dispatch/runners/garbage-battery.test.ts":
		"runner fixtures, not a production population sweep",
	"tests/clients/dispatch/runners/helm-render.test.ts":
		"render fixtures, not a production population sweep",
	"tests/clients/dispatch/runners/parsed-nothing-sweep.test.ts":
		"runner outcome cases, not a production population sweep",
	"tests/clients/dispatch/runners/run-outcome-ratchet.test.ts":
		"runner outcome cases, not a production population sweep",
	"tests/clients/extension-terminal-silence.test.ts":
		"terminal behavior cases, not a production population sweep",
	"tests/clients/gzip-stage-write.test.ts":
		"gzip stage cases, not a production population sweep",
	"tests/clients/instance-reaper-prune-concurrency.test.ts":
		"concurrency cases, not a production population sweep",
	"tests/clients/instance-registry.test.ts":
		"registry behavior cases, not a production population sweep",
	"tests/clients/lsp/edits.test.ts":
		"edit behavior cases, not a production population sweep",
	"tests/clients/lsp/ruby-drive-dirs.test.ts":
		"path behavior cases, not a production population sweep",
	"tests/clients/managed-tool-seam-coverage.test.ts":
		"managed-tool seam cases, not a production population sweep",
	"tests/clients/pi-host-contract.test.ts":
		"host contract cases, not a production population sweep",
	"tests/clients/project-diagnostics/scanner.test.ts":
		"scanner behavior cases, not a production population sweep",
	"tests/clients/project-snapshot.test.ts":
		"snapshot behavior cases, not a production population sweep",
	"tests/clients/recent-touches.test.ts":
		"touch behavior cases, not a production population sweep",
	"tests/clients/review-graph-git-stamp.test.ts":
		"graph behavior cases, not a production population sweep",
	"tests/clients/review-graph-superseded-persist.test.ts":
		"persistence behavior cases, not a production population sweep",
	"tests/clients/session-state-store.test.ts":
		"store behavior cases, not a production population sweep",
	"tests/clients/tree-sitter-879-post-filters.test.ts":
		"tree-sitter behavior cases, not a production population sweep",
	"tests/clients/tree-sitter-cache-stats-astgrep-coverage.test.ts":
		"tree-sitter behavior cases, not a production population sweep",
	"tests/host-sdk-type-only.test.ts":
		"host type cases, not a production population sweep",
	"tests/packaging.test.ts":
		"packaging behavior cases, not a production population sweep",
	"tests/scripts/no-hardcoded-machine-paths.test.ts":
		"path policy cases, not a production population sweep",
	"tests/scripts/rollup-changelog.test.ts":
		"changelog behavior cases, not a production population sweep",
	"tests/scripts/smoke-tools-cue-fixture.test.ts":
		"smoke fixture cases, not a production population sweep",
	"tests/scripts/warm-loader-cache.test.ts":
		"loader behavior cases, not a production population sweep",
	"tests/skills/skill-doc-drift.test.ts":
		"skill documentation cases, not a production population sweep",
	"tests/typescript-runtime-free.test.ts":
		"runtime dependency cases, not a production population sweep",
};

describe("registered-or-fail sweep floors", () => {
	it("every sweep-shaped test uses sweep-kit or declares a reason", () => {
		const files = sweepShapeFiles().map((file) =>
			relativePosix(REPO_ROOT, file),
		);
		const registered = files.filter((file) => {
			const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
			return (
				/assertNonEmptyScan\s*\(/.test(source) ||
				/auditRegistry\s*\(\s*\{[\s\S]*?\bminScanned\s*:/.test(source)
			);
		});
		const scannedCount = listSourceFiles(TESTS_ROOT, {
			extensions: [".ts"],
		}).filter((file) => file.endsWith(".test.ts")).length;
		const audit = auditRegistry({
			sweepName: "sweep-floor meta-sweep",
			flagged: files,
			registered,
			exemptions: DECLARED_EXCEPTIONS,
			// Calibration: 780 test files walked on 2026-08-26; half is 390,
			// rounded up to the documented 400 floor.
			scannedCount,
			minScanned: 400,
			// Calibration: this census flags 13 sweep-shaped files today; half
			// is 20. Recalibrate from the census when the suite grows materially.
			minFlagged: 20,
			minReasonLength: 20,
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});
});
