import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

// PHP 8.3's `-l` returns 1 for a syntax-check failure in the usual CLI path,
// and 255 for the parse-error wire captured on Windows. Both are completed
// analyses whose stderr/stdout must reach the parser.
const PHP_LINT_EXIT_CODES = { ran: [1, 255] } as const;

const php = createAvailabilityChecker("php", ".exe");

function parsePhpLintOutput(raw: string, filePath: string): Diagnostic[] {
	const output = raw.trim();
	if (!output || !/(?:PHP )?Parse error:/i.test(output)) return [];

	const lineMatch = output.match(/on line (\d+)/i);
	const messageMatch =
		output.match(/PHP Parse error:\s*(.+?)(?:\s+in\s+.+?\s+on line \d+)?$/im) ??
		output.match(/Parse error:\s*(.+?)(?:\s+in\s+.+?\s+on line \d+)?$/im);

	return [
		{
			id: `php-lint:${lineMatch?.[1] ?? "1"}`,
			message: messageMatch?.[1]?.trim() ?? output,
			filePath,
			line: lineMatch ? Number.parseInt(lineMatch[1], 10) : 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "php-lint",
			rule: "syntax",
			fixable: false,
		},
	];
}

const phpLintRunner: RunnerDefinition = {
	id: "php-lint",
	appliesTo: ["php"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "php-lint");
		if (!(await php.isAvailableAsync(cwd))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = php.getCommand(cwd);
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(cmd, ["-l", absPath], {
			timeout: 15000,
			cwd,
		});
		// PHP documents `-l` as a syntax check: zero is clean and nonzero is a
		// parse failure. Keep its stderr wire alongside stdout for parse errors.
		const run = parseToolRun<Diagnostic>(
			"php-lint",
			{ result },
			(output) => parsePhpLintOutput(output, ctx.filePath),
			{
				parseOutput: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
				exitCodes: PHP_LINT_EXIT_CODES,
			},
		);
		if (run.skipped) return run.skipped;
		return finishParsedRun({
			tool: "php-lint",
			ctx,
			result,
			diagnostics: run.diagnostics,
			classify: () => ({ status: "failed", semantic: "blocking" }),
		});
	},
};

export default phpLintRunner;
