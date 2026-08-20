import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	_setBeforeWarningStateLockForTests,
	buildActionableWarningsReport,
	checkActionableWarningsReportFresh,
	createActionableWarningId,
	formatActionableWarningsAdvisory,
	recordFromDispatchDiagnostic,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { removeTempDirSync } from "./test-utils.js";

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => ({
		supportsLSP: () => false,
	}),
}));

function makeWarning(filePath: string): Diagnostic {
	return {
		id: "tree:no-console:10",
		message: "console.log in test block — use proper assertions or logging",
		filePath,
		line: 10,
		column: 2,
		severity: "warning",
		semantic: "warning",
		tool: "tree-sitter",
		rule: "no-console-in-tests",
		fixable: true,
		fixKind: "suggestion",
		fixSuggestion: "remove this statement",
	};
}

describe("actionable warnings", () => {
	it("preserves a sibling writer's concurrent suppression", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-lock-"));
		const filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "console.log('x');\n");
		const record = recordFromDispatchDiagnostic(makeWarning(filePath), cwd);
		expect(record).toBeDefined();
		try {
			_setBeforeWarningStateLockForTests(() => {
				const projectData = getProjectDataDir(cwd);
				const suppressionPath = path.join(
					projectData,
					"cache",
					"actionable-warning-state.json",
				);
				fs.mkdirSync(path.dirname(suppressionPath), { recursive: true });
				fs.writeFileSync(
					suppressionPath,
					JSON.stringify({
						warnings: {
							[record!.id]: {
								status: "suppressed",
								reason: "writer B",
							},
						},
					}),
				);
			});
			await buildActionableWarningsReport({
				cwd,
				sessionId: "writer-a",
				turnIndex: 1,
				files: [filePath],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: [record!],
				includeLspCodeActions: false,
			});
			const persisted = JSON.parse(
				fs.readFileSync(
					path.join(getProjectDataDir(cwd), "cache", "actionable-warning-state.json"),
					"utf8",
				),
			) as { warnings: Record<string, { status?: string; reason?: string }> };
			expect(persisted.warnings[record!.id]).toMatchObject({
				status: "suppressed",
				reason: "writer B",
			});
		} finally {
			_setBeforeWarningStateLockForTests(null);
			removeTempDirSync(cwd);
		}
	});

	it("creates stable ids for equivalent diagnostics", () => {
		const cwd = path.join(os.tmpdir(), "project");
		const filePath = path.join(cwd, "src", "a.ts");
		const left = createActionableWarningId({
			cwd,
			filePath,
			tool: "tree-sitter",
			rule: "no-console",
			message: "Remove   console.log",
			line: 3,
		});
		const right = createActionableWarningId({
			cwd,
			filePath,
			tool: "tree-sitter",
			rule: "no-console",
			message: "remove console.log",
			line: 3,
		});
		expect(left).toBe(right);
		expect(left).toMatch(/^aw:[0-9a-f]{10}$/);
	});

	it("detects stale actionable warning reports by project and file sequence", () => {
		const report: ActionableWarningsReport = {
			generatedAt: new Date().toISOString(),
			scope: "turn_delta",
			sessionId: "s1",
			turnIndex: 1,
			projectSeqEnd: 5,
			deltaOnly: true,
			includeLspCodeActions: true,
			files: [
				{
					filePath: path.join(os.tmpdir(), "project", "src", "a.ts"),
					displayPath: "src/a.ts",
					fileSeq: 2,
					warnings: [],
				},
			],
			summary: {
				warnings: 0,
				unsuppressed: 0,
				suppressed: 0,
				files: 1,
				actions: 0,
				autoFixEligible: 0,
			},
		};

		expect(
			checkActionableWarningsReportFresh({
				report,
				currentProjectSeq: 6,
			}),
		).toMatchObject({ fresh: false, reason: "project_seq_mismatch" });
		expect(
			checkActionableWarningsReportFresh({
				report,
				currentProjectSeq: 5,
				getFileSeq: () => 3,
			}),
		).toMatchObject({ fresh: false, reason: "file_seq_mismatch" });
		expect(
			checkActionableWarningsReportFresh({
				report,
				currentProjectSeq: 5,
				getFileSeq: () => 2,
			}),
		).toMatchObject({ fresh: true });
	});

	it("serializes dispatch fixable warnings into the turn report", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-"));
		const filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "console.log('x');\n");
		try {
			const record = recordFromDispatchDiagnostic(makeWarning(filePath), cwd);
			expect(record).toBeDefined();
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: "s1",
				turnIndex: 2,
				projectSeqStart: 4,
				projectSeqEnd: 5,
				fileSeqByPath: new Map([[filePath.replace(/\\/g, "/"), 1]]),
				files: ["src/a.ts"],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: record ? [record] : [],
				includeLspCodeActions: false,
			});
			expect(report.summary).toMatchObject({
				warnings: 1,
				unsuppressed: 1,
				files: 1,
			});
			expect(report).toMatchObject({ projectSeqStart: 4, projectSeqEnd: 5 });
			expect(report.files[0]?.fileSeq).toBe(1);
			expect(report.files[0]?.warnings[0]?.fixSuggestion).toBe(
				"remove this statement",
			);
			expect(formatActionableWarningsAdvisory(report)).toContain(
				"Fixable warnings introduced this turn: 1",
			);
		} finally {
			removeTempDirSync(cwd);
		}
	});

	// #1777: the dispatch path now preserves hint and info, so the fixable-warning
	// advisory says how much of its count is style opinion rather than defect.
	it("splits the turn report by severity tier and names the quiet tiers", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-tier-"));
		const filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "console.log('x');\n");
		try {
			const records = (["warning", "hint", "hint"] as const).map(
				(severity, index) =>
					recordFromDispatchDiagnostic(
						{
							...makeWarning(filePath),
							id: `tier-${index}`,
							severity,
							line: 10 + index,
							message: `${severity} finding ${index}`,
						},
						cwd,
					),
			);
			expect(records.every(Boolean)).toBe(true);
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: "s-tier",
				turnIndex: 1,
				files: ["src/a.ts"],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: records.map((record) => record!),
				includeLspCodeActions: false,
			});
			expect(report.summary.byTier).toMatchObject({
				warning: 1,
				info: 0,
				hint: 2,
			});
			// #1799: `error` severity never reaches `warnings` (recordFromDispatchDiagnostic
			// routes it to the blocking path), so `byTier` no longer carries a vestigial
			// always-0 `error` field.
			expect(report.summary.byTier).not.toHaveProperty("error");
			expect(formatActionableWarningsAdvisory(report)).toContain(
				"2 of those are hint/info tier",
			);
		} finally {
			removeTempDirSync(cwd);
		}
	});

	it("omits the tier line when every fixable warning is warning-tier", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-tier2-"));
		const filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "console.log('x');\n");
		try {
			const record = recordFromDispatchDiagnostic(makeWarning(filePath), cwd);
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: "s-tier",
				turnIndex: 1,
				files: ["src/a.ts"],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: record ? [record] : [],
				includeLspCodeActions: false,
			});
			expect(report.summary.byTier).toMatchObject({ warning: 1, hint: 0 });
			expect(formatActionableWarningsAdvisory(report)).not.toContain(
				"hint/info tier",
			);
		} finally {
			removeTempDirSync(cwd);
		}
	});

	// `actionable-warnings.json` is read back by `clients/runtime-agent-end.ts`
	// and `tools/lens-diagnostics.ts`, which can find a file written by a build
	// that predates `byTier`. The advisory must not crash on it.
	it("formats a cached report that predates the byTier field", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-tier3-"));
		const filePath = path.join(cwd, "src", "a.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "console.log('x');\n");
		try {
			const record = recordFromDispatchDiagnostic(makeWarning(filePath), cwd);
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: "s-tier",
				turnIndex: 1,
				files: ["src/a.ts"],
				modifiedRangesByFile: new Map(),
				dispatchWarnings: record ? [record] : [],
				includeLspCodeActions: false,
			});
			const legacy: ActionableWarningsReport = {
				...report,
				summary: { ...report.summary, byTier: undefined },
			};
			expect(formatActionableWarningsAdvisory(legacy)).toContain(
				"Fixable warnings introduced this turn: 1",
			);
		} finally {
			removeTempDirSync(cwd);
		}
	});
});
