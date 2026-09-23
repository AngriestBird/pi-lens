import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const gleam = createAvailabilityChecker("gleam", ".exe");

function parseGleamOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = raw.split(/\r?\n/);
	const absTarget = path.resolve(cwd, filePath);
	for (let i = 0; i < lines.length; i++) {
		const location = lines[i].match(/^(.+?):(\d+):(\d+)$/);
		if (!location) continue;
		const [, sourcePath, lineStr, colStr] = location;
		// #3278: one seam for reported-path attribution — see javac.ts. The
		// `endsWith` arm this replaces attached ANY reported path whose tail spelled
		// the dispatched file, and hand-rolled its own separator fold to do it.
		if (!pathsEqual(path.resolve(cwd, sourcePath.trim()), absTarget)) {
			continue;
		}
		const message = lines.slice(i + 1).find((line) => line.trim().length > 0);
		diagnostics.push({
			id: `gleam-check-${lineStr}-${colStr}`,
			message: message?.trim() || "gleam check reported an error",
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr, 10) || 1,
			severity: "error",
			semantic: "blocking",
			tool: "gleam",
			rule: "gleam-check",
			fixable: false,
		});
	}
	return diagnostics;
}

function firstOutputLine(result: { stdout?: string; stderr?: string }): string {
	return `${result.stderr || ""}\n${result.stdout || ""}`
		.trim()
		.split(/\r?\n/, 1)[0]
		.slice(0, 200);
}

const gleamCheckRunner: RunnerDefinition = {
	id: "gleam-check",
	appliesTo: ["gleam"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "gleam-check");
		if (!(await gleam.isAvailableAsync(cwd))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = gleam.getCommand(cwd)!;
		const result = await safeSpawnAsync(cmd, ["check"], {
			cwd,
			timeout: 30000,
		});

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseGleamOutput(
			`${result.stderr || ""}\n${result.stdout || ""}`,
			ctx.filePath,
			cwd,
		);
		if (diagnostics.length === 0) {
			if (result.status && result.status !== 0) {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "gleam-check-nonzero-no-diagnostics",
							message:
								firstOutputLine(result) ||
								"gleam check exited non-zero without structured diagnostics",
							filePath: ctx.filePath,
							severity: "error",
							semantic: "blocking",
							tool: "gleam",
							rule: "gleam-check",
							fixable: false,
						},
					],
					semantic: "blocking",
				};
			}
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return {
			status: "failed",
			diagnostics,
			semantic: "blocking",
		};
	},
};

export default gleamCheckRunner;
