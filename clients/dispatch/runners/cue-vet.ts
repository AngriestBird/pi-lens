/**
 * `cue vet` — CUE evaluation-error validation (#1522).
 *
 * `cue lsp serve` reports load and parse (syntax) errors as you type
 * (`clients/lsp/wait-policy/strategies.ts`'s `cue` entry) but deliberately
 * leaves conflicting concrete values and failed constraints to `cue vet` —
 * per the CUE wiki, that class needs a full evaluation pass the language
 * server does not run on every keystroke. This runner is the auxiliary that
 * covers the gap, in the same "LSP covers syntax, a CLI covers the rest"
 * shape as terraform's `lsp, tflint, trivy-config` group.
 *
 * `-c=false` (allow incomplete values) is deliberate, not a shortcut: CUE's
 * default `cue vet` requires every regular field to be concrete, so an
 * ordinary schema-only file — a `#Definition` library with no concrete data,
 * a very common authoring pattern — fails vet's default gate with a generic
 * "some instances are incomplete" message and nothing to point at. That is
 * noise, not a defect. `-c=false` accepts incomplete values and still
 * reports a genuine type conflict (verified: `a: int & "hello"` still fails
 * with `-c=false`, an incomplete `a: int` no longer does) — see the fixture
 * at tests/fixtures/tool-smoke/cue-vet/bad.cue.
 *
 * Runs only the TOUCHED file (`cue vet <file>`), matching every other
 * per-edit linter in this dispatch set (tflint, hadolint, …): a cue package
 * can span multiple files, so a cross-file conflict involving a sibling file
 * is out of scope here, same tradeoff every single-file runner already
 * makes.
 */

import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
} from "./utils/runner-helpers.js";
import { spawnFailedWithNoOutput } from "./utils/spawn-outcome.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const cue = createAvailabilityChecker("cue", ".exe", ["version"]);

interface CueVetError {
	message: string;
	line?: number;
	column?: number;
}

/**
 * `cue vet` reports each error as a header line (a field path or a bare
 * message, ending in `:`) followed by one or more indented location lines
 * (`    .\path:line:col`). A syntax error has no field-path prefix; a
 * conflicting-value error carries one location per conflicting side — the
 * FIRST is used, matching the field's own declaration site closest to what
 * the user is looking at.
 *
 * Verified against cue v0.17.1:
 *   a: conflicting values int and "hello" (mismatched types int and string):
 *       .\bad.cue:3:4
 *       .\bad.cue:3:10
 *   expected '}', found 'EOF':
 *       .\syntax.cue:2:6
 *
 * A summary-only failure (no header/location pair at all — e.g. the
 * "some instances are incomplete" message `-c=false` is meant to prevent, or
 * an unrecognized shape from a future cue version) is intentionally NOT
 * silently dropped: the caller falls back to one whole-output diagnostic so
 * a real vet failure can never present as zero findings (recurring defect
 * shape 10).
 */
export function parseCueVetOutput(raw: string): CueVetError[] {
	const errors: CueVetError[] = [];
	let current: CueVetError | null = null;
	for (const rawLine of raw.split(/\r?\n/)) {
		if (!rawLine.trim()) continue;
		if (/^\s/.test(rawLine)) {
			if (current && current.line === undefined) {
				const loc = rawLine.trim().match(/:(\d+):(\d+)$/);
				if (loc) {
					current.line = Number.parseInt(loc[1], 10);
					current.column = Number.parseInt(loc[2], 10);
				}
			}
			continue;
		}
		if (current) errors.push(current);
		current = { message: rawLine.replace(/:\s*$/, "").trim() };
	}
	if (current) errors.push(current);
	return errors;
}

function toDiagnostics(errors: CueVetError[], filePath: string): Diagnostic[] {
	return errors.map((error, index) => ({
		id: `cue-vet-${index + 1}-${error.line ?? 0}`,
		message: error.message || "cue vet reported an error",
		filePath,
		line: error.line ?? 1,
		column: error.column ?? 1,
		severity: "error",
		semantic: "blocking",
		tool: "cue-vet",
		rule: "vet",
		fixable: false,
	}));
}

const cueVetRunner: RunnerDefinition = {
	id: "cue-vet",
	appliesTo: ["cue"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,
	timeoutMs: 30_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		let cmd: string | null = null;
		if (await cue.isAvailableAsync(cwd)) {
			cmd = cue.getCommand(cwd);
		} else {
			cmd = await resolveAvailableOrInstall(cue, "cue", cwd);
		}
		// An unspawnable `cue` is never a durable "clean" verdict — skip, so the
		// dispatcher's own absence handling reports the gap rather than this
		// runner manufacturing a false "0 findings" (recurring defect shape 10).
		// `createAvailabilityChecker`/`resolveAvailableOrInstall` already route
		// through the shared classify/latch policy, so a probe timeout or host
		// stall re-arms on its own cooldown instead of latching here.
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const fileDir = path.dirname(absPath);
		const fileName = path.basename(absPath);

		const result = await safeSpawnAsync(
			cmd,
			["vet", "-c=false", `./${fileName}`],
			{ cwd: fileDir, timeout: 30_000 },
		);

		if (spawnFailedWithNoOutput(result, `${result.stdout}${result.stderr}`)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// `cue vet` is silent on success (empty stdout, exit 0) — that IS the
		// clean signal, not an unavailable/errored one, so status 0 with no
		// output reports succeeded/no-findings rather than falling through to
		// the skip above.
		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const raw = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
		const errors = parseCueVetOutput(raw);
		const diagnostics =
			errors.length > 0
				? toDiagnostics(errors, ctx.filePath)
				: // Nonzero exit, some output, but nothing this parser recognized —
					// a real failure must not present as zero findings.
					[
						{
							id: "cue-vet-unparsed",
							message: raw.slice(0, 300) || "cue vet exited non-zero",
							filePath: ctx.filePath,
							line: 1,
							column: 1,
							severity: "error" as const,
							semantic: "blocking" as const,
							tool: "cue-vet",
							rule: "vet",
							fixable: false,
						},
					];

		return { status: "failed", diagnostics, semantic: "blocking" };
	},
};

export default cueVetRunner;
