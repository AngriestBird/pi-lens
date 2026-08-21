import * as path from "node:path";
import { findLocalBinUpwards } from "../../package-manager.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	lspPrimaryCoversFile,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";
import { spawnFailedWithNoOutput } from "./utils/spawn-outcome.js";

const taplo = createAvailabilityChecker("taplo", ".exe");

/**
 * Parse `taplo lint` output (#1937).
 *
 * This parser used to `JSON.parse` a `{ errors: [{ range, message, kind }] }`
 * envelope that taplo has never emitted, fed by a `--output=json` flag taplo
 * has never accepted. Real taplo rejected the flag with exit 2 and a usage
 * error, the JSON parse threw, the catch returned [], and malformed TOML was
 * reported clean. Same shape as the vale parser in #1933.
 *
 * Real taplo 0.10.0 writes codespan diagnostics to STDERR, interleaved with
 * uppercase tracing lines:
 *
 *     error: invalid TOML
 *       ┌─ /path/to/bad.toml:2:9
 *       │
 *     2 │   [package
 *
 * Verified against tests/fixtures/runner-output/taplo/real.captured.json.
 */
export function parseTaploOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = (raw ?? "").split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		// Lowercase `error:`/`warning:` starts a diagnostic. taplo's tracing
		// lines are uppercase (`ERROR taplo:lint_files: ...`) and carry no
		// location, so a case-sensitive match keeps them out.
		const header = lines[i].match(/^\s*(error|warning):\s*(.+?)\s*$/);
		if (!header) continue;
		const [, severityWord, summary] = header;

		// The location arrives on a following `┌─ file:line:col` line. Scan a
		// short window rather than assuming adjacency: taplo puts a gutter line
		// between them in some layouts.
		let line = 1;
		let column = 1;
		for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
			const location = lines[j].match(/┌─+\s*.*:(\d+):(\d+)\s*$/);
			if (!location) continue;
			line = Number.parseInt(location[1], 10) || 1;
			column = Number.parseInt(location[2], 10) || 1;
			break;
		}

		const severity = severityWord === "warning" ? "warning" : "error";
		diagnostics.push({
			id: `taplo-${severity}-${line}-${column}`,
			message: summary,
			filePath,
			line,
			column,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "taplo",
			rule: `taplo/${severity}`,
			fixable: false,
		});
	}

	return diagnostics;
}

const taploRunner: RunnerDefinition = {
	id: "taplo",
	appliesTo: ["toml"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("taplo")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// #233: the `toml` LSP server IS `taplo lsp` (same binary). When that LSP
		// covers this file, the warm server already produces these diagnostics —
		// skip the redundant CLI scan to avoid double-reporting. Stays active when
		// the LSP is disabled/unavailable so TOML coverage never regresses.
		if (lspPrimaryCoversFile(ctx, "toml") && (await ctx.hasTool("taplo"))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Project binary first (#1731, discipline B): `taplo.isAvailableAsync`
		// resolves through `findManagedNodeToolBinary`, pi-lens's own managed
		// shim — checked BEFORE any project-local candidate, so a project's own
		// `node_modules/.bin/taplo` (npm `@taplo/cli`) never won once the managed
		// copy answered. `findLocalBinUpwards` defaults to `.cmd` on Windows,
		// matching that npm shim; the availability checker's `.exe` extension is
		// correct for pi-lens's OWN managed install (a GitHub-release binary,
		// `clients/installer/index.ts` taplo entry), a different artifact with a
		// different extension, so it stays as the checker's fallback only.
		let cmd: string | null = findLocalBinUpwards("taplo", cwd) ?? null;
		if (!cmd) {
			if (await taplo.isAvailableAsync(cwd)) {
				cmd = taplo.getCommand(cwd);
			} else {
				cmd = await resolveToolCommandWithInstallFallback(cwd, "taplo");
			}
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		// #1937: `--output=json` is not a taplo flag. taplo rejected it with a
		// usage error, so this runner never linted anything. `--colors never`
		// keeps ANSI escapes out of the bytes the parser reads.
		const result = await safeSpawnAsync(
			cmd,
			["check", "--colors", "never", absPath],
			{ cwd, timeout: 15000 },
		);

		// taplo reports on stderr and leaves stdout empty, so the
		// "nothing to parse" test must read the same string the parser gets —
		// otherwise every real run looks like a failed spawn.
		const raw = result.stderr?.trim() ? result.stderr : (result.stdout ?? "");
		if (spawnFailedWithNoOutput(result, raw)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseTaploOutput(raw, ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return { status: "failed", diagnostics, semantic: "blocking" };
	},
};

export default taploRunner;
