import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { markDisposition } from "../../clients/diagnostic-dispositions.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

// #1617: turn_end's own secrets gate ("🔴 STOP — hardcoded secrets detected")
// is the literal surface the dogfood incident hit — an agent marked a
// gitleaks finding false-positive via lens_diagnostic_mark, but the NEXT
// turn's gate read gitleaks's session-scan cache straight into the blocker
// report with zero disposition wiring, so the same finding re-reported on
// every turn. These prove the fix reaches this exact gate, not just
// `lens_diagnostics mode=full`'s parallel (also-fixed) surface.

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
) {
	return {
		ctxCwd: cwd,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

describe("turn_end secrets gate honors dispositions (#1617)", () => {
	it("re-reports a gitleaks finding as a 🔴 STOP blocker when unmarked, then drops it once marked false-positive", async () => {
		const env = setupTestEnvironment("pi-lens-turnend-secrets-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "a.ts");
			const content = "const clientId = 'not-a-real-secret';\n";
			fs.writeFileSync(filePath, content);

			const cacheManager = new CacheManager(false);
			// handleTurnEnd short-circuits (schedules an idle LSP reset and
			// returns) when no file was touched this turn — register a modified
			// range so it runs the full findings pipeline, same as the existing
			// cascade turn-end tests do.
			cacheManager.addModifiedRange(filePath, { start: 1, end: 1 }, false, cwd);
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					findings: [
						{
							ruleId: "generic-api-key",
							file: filePath,
							startLine: 1,
						},
					],
					scannedAt: new Date().toISOString(),
				},
				cwd,
			);

			// Baseline: unmarked finding IS a blocker.
			const runtimeBefore = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeBefore, cacheManager, cwd));
			const before = consumeTurnEndFindings(cacheManager, cwd);
			expect(before?.messages[0]?.content ?? "").toContain(
				"STOP — hardcoded secrets detected",
			);

			// Mark it false-positive using the SAME identity
			// `gitleaksFindingToProjectDiagnostic` derives (tool="gitleaks",
			// rule="gitleaks:<ruleId>", the exact "Potential secret: …" message)
			// — what an agent would have gotten from lens_diagnostics and fed
			// straight into lens_diagnostic_mark.
			markDisposition(
				cwd,
				{
					cwd,
					filePath,
					tool: "gitleaks",
					rule: "gitleaks:generic-api-key",
					message: "Potential secret: generic-api-key",
					line: 1,
					content,
				},
				"false-positive",
			);

			cacheManager.addModifiedRange(filePath, { start: 1, end: 1 }, false, cwd);
			const runtimeAfter = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeAfter, cacheManager, cwd));
			const after = consumeTurnEndFindings(cacheManager, cwd);
			const afterContent = after?.messages[0]?.content ?? "";
			expect(afterContent).not.toContain("STOP — hardcoded secrets detected");
			// #1616 suppressed-bucket rule: the drop must stay visible as a trace.
			expect(afterContent).toContain("suppressed by disposition");
		} finally {
			env.cleanup();
		}
	});
});

// #1628: trivy's own *secret* findings (`TrivyResult.secrets`) never passed
// through the same fix — they were never adapted to a `ProjectDiagnostic` at
// all, so an agent had nothing to anchor a `lens_diagnostic_mark` call
// against and a mark could never suppress one. Mirrors the #1617 gitleaks
// case above, exercising a trivy-only secret (no gitleaks corroboration) so
// the disposition anchor under test is genuinely `trivySecretFindingToProjectDiagnostic`'s,
// not `gitleaksFindingToProjectDiagnostic`'s.
describe("turn_end secrets gate honors dispositions for trivy secrets (#1628)", () => {
	it("re-reports a trivy-secret finding as a 🔴 STOP blocker when unmarked, then drops it once marked false-positive", async () => {
		const env = setupTestEnvironment("pi-lens-turnend-trivy-secrets-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "b.ts");
			const content = "const apiKey = 'not-a-real-secret';\n";
			fs.writeFileSync(filePath, content);

			const cacheManager = new CacheManager(false);
			cacheManager.addModifiedRange(filePath, { start: 1, end: 1 }, false, cwd);
			cacheManager.writeCache(
				"trivy",
				{
					success: true,
					scannedAt: new Date().toISOString(),
					findings: [],
					secrets: [
						{
							ruleId: "aws-access-key-id",
							file: filePath,
							line: 1,
						},
					],
					licenses: [],
				},
				cwd,
			);

			// Baseline: unmarked finding IS a blocker.
			const runtimeBefore = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeBefore, cacheManager, cwd));
			const before = consumeTurnEndFindings(cacheManager, cwd);
			expect(before?.messages[0]?.content ?? "").toContain(
				"STOP — hardcoded secrets detected",
			);

			// Mark it false-positive using the SAME identity
			// `trivySecretFindingToProjectDiagnostic` derives (tool="trivy",
			// rule="trivy-secret:<ruleId>", the exact "Potential secret: …"
			// message) — what an agent would have gotten from lens_diagnostics
			// and fed straight into lens_diagnostic_mark.
			markDisposition(
				cwd,
				{
					cwd,
					filePath,
					tool: "trivy",
					rule: "trivy-secret:aws-access-key-id",
					message: "Potential secret: aws-access-key-id",
					line: 1,
					content,
				},
				"false-positive",
			);

			cacheManager.addModifiedRange(filePath, { start: 1, end: 1 }, false, cwd);
			const runtimeAfter = new RuntimeCoordinator();
			await handleTurnEnd(makeTurnEndDeps(runtimeAfter, cacheManager, cwd));
			const after = consumeTurnEndFindings(cacheManager, cwd);
			const afterContent = after?.messages[0]?.content ?? "";
			expect(afterContent).not.toContain("STOP — hardcoded secrets detected");
			// #1616 suppressed-bucket rule: the drop must stay visible as a trace.
			expect(afterContent).toContain("suppressed by disposition");
		} finally {
			env.cleanup();
		}
	});
});
