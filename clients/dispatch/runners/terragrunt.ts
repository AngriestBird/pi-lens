import * as path from "node:path";
import { ensureTool } from "../../installer/index.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const terragrunt = createAvailabilityChecker("terragrunt", ".exe");

interface TerragruntDiagnostic {
	severity?: string | number;
	summary?: string;
	detail?: string;
	range?: {
		filename?: string;
		start?: { line?: number; column?: number };
	};
}

interface TerragruntInvalidFile {
	diagnostics?: TerragruntDiagnostic[];
}

function normalizeSeverity(raw: unknown): "error" | "warning" {
	if (typeof raw === "number") return raw === 1 ? "error" : "warning";
	if (typeof raw === "string" && raw.toLowerCase() === "error") return "error";
	return "warning";
}

function toRawDiagnostics(parsed: unknown): TerragruntDiagnostic[] {
	if (Array.isArray(parsed)) return parsed as TerragruntDiagnostic[];
	if (!parsed || typeof parsed !== "object") return [];
	const invalidFiles = (parsed as { invalid_files?: unknown }).invalid_files;
	if (!Array.isArray(invalidFiles)) return [];
	return (invalidFiles as TerragruntInvalidFile[]).flatMap((f) =>
		Array.isArray(f?.diagnostics) ? f.diagnostics : [],
	);
}

/**
 * Parse `terragrunt hcl validate --json` output. Shape is unverified (the CLI
 * isn't installed in this environment) — accept both the nested
 * `{invalid_files:[{diagnostics:[...]}]}` shape and a flat diagnostic array,
 * and accept severity as either numeric (1=error, 2=warning) or a string.
 * Malformed/unparseable input returns [].
 */
export function parseTerragruntOutput(
	raw: string,
	filePath: string,
): Diagnostic[] {
	if (!raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	const fileBase = path.basename(filePath);
	const diagnostics: Diagnostic[] = [];
	for (const d of toRawDiagnostics(parsed)) {
		if (!d || typeof d !== "object") continue;
		const diagFile = d.range?.filename;
		if (diagFile && path.basename(diagFile) !== fileBase) continue;
		const line = d.range?.start?.line ?? 1;
		const column = d.range?.start?.column ?? 1;
		const severity = normalizeSeverity(d.severity);
		const message = d.summary ?? d.detail ?? "terragrunt hcl validate error";
		diagnostics.push({
			id: `terragrunt-hclvalidate-${line}`,
			message,
			filePath,
			line,
			column,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "terragrunt",
			fixable: false,
		});
	}
	return diagnostics;
}

const SKIPPED: RunnerResult = {
	status: "skipped",
	diagnostics: [],
	semantic: "none",
};

const terragruntRunner: RunnerDefinition = {
	id: "terragrunt",
	appliesTo: ["terragrunt"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("terragrunt"))
			return SKIPPED;

		let cmd: string | null = null;
		if (await terragrunt.isAvailableAsync(cwd)) {
			cmd = terragrunt.getCommand(cwd);
		} else {
			const managed = await ensureTool("terragrunt");
			if (managed) cmd = managed;
		}

		if (!cmd) return SKIPPED;

		const absPath = path.resolve(cwd, ctx.filePath);
		const fileDir = path.dirname(absPath);
		const result = await safeSpawnAsync(
			cmd,
			[
				"hcl",
				"validate",
				"--json",
				"--non-interactive",
				`--filter=${path.basename(absPath)}`,
			],
			{ cwd: fileDir, timeout: 30000 },
		);

		if (result.error && !result.stdout) return SKIPPED;

		const diagnostics = parseTerragruntOutput(result.stdout || "", ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default terragruntRunner;
