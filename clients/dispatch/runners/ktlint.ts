import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import {
	getAutofixCapability,
	getLinterPolicyForCwd,
} from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

const ktlint = createAvailabilityChecker("ktlint", ".exe");

interface KtlintError {
	line: number;
	col: number;
	detail: string;
	ruleId: string;
}

interface KtlintResult {
	file?: string;
	errors: KtlintError[];
}

function normalizeKtlintResults(parsed: unknown): KtlintResult[] | null {
	if (Array.isArray(parsed)) {
		return parsed as KtlintResult[];
	}
	if (
		parsed &&
		typeof parsed === "object" &&
		Array.isArray((parsed as KtlintResult).errors)
	) {
		return [parsed as KtlintResult];
	}
	return null;
}

function parseKtlintOutput(raw: string, filePath: string): Diagnostic[] | null {
	try {
		const parsed = normalizeKtlintResults(JSON.parse(raw));
		if (!parsed) return null;

		const autofix = getAutofixCapability("ktlint");
		const diagnostics: Diagnostic[] = [];
		for (const result of parsed) {
			for (const err of result.errors ?? []) {
				diagnostics.push({
					id: `ktlint-${err.ruleId}-${err.line}-${err.col}`,
					message: `[${err.ruleId}] ${err.detail}`,
					filePath,
					line: err.line,
					column: err.col,
					severity: "warning",
					semantic: "warning",
					tool: "ktlint",
					rule: err.ruleId,
					fixable: true,
					autoFixAvailable: autofix?.safePipelineAutofix ?? false,
					fixKind: autofix?.fixKind === "none" ? undefined : autofix?.fixKind,
				});
			}
		}
		return diagnostics;
	} catch {
		return null;
	}
}

const ktlintRunner: RunnerDefinition = {
	id: "ktlint",
	appliesTo: ["kotlin"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "ktlint");
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("ktlint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (await ktlint.isAvailableAsync(cwd)) {
			cmd = ktlint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "ktlint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(cmd, ["--reporter=json", absPath], {
			cwd,
			timeout: 30000,
		});

		// Ktlint documents zero for clean and nonzero for lint violations. The
		// shared gates keep unavailable/signal runs distinct and never skip a
		// nonzero run that carries valid JSON findings.
		const run = parseToolRun<Diagnostic>(
			"ktlint",
			{ result },
			(output) => parseKtlintOutput(output, ctx.filePath) ?? [],
			{
				parseOutput: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
				exitCodes: { ran: [1] },
			},
		);
		if (run.skipped) return run.skipped;
		return finishParsedRun({
			tool: "ktlint",
			ctx,
			result,
			diagnostics: run.diagnostics,
		});
	},
};

export default ktlintRunner;
