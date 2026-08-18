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
 * ## Package-scoped, not file-scoped (review round 1, F1)
 *
 * CUE packages are DIRECTORY-scoped: every `.cue` file in a directory
 * sharing a `package` clause is unified into one value. Vetting only the
 * touched file (`cue vet <file>`) was a false-positive machine on the
 * normative split-schema/values authoring style — a `#Service` defined in
 * `schema.cue` and referenced from `values.cue` vets clean as a package but
 * fails `values.cue` alone with `reference "#Service" not found`, because
 * the single-file invocation never loads the sibling that defines it.
 * Verified: a valid two-file package vets clean as `cue vet -c=false .`
 * (exit 0, empty output) but reports a blocking error for `values.cue` in
 * isolation.
 *
 * The fix runs `cue vet -c=false .` from the touched file's directory (the
 * whole package) and then filters the reported errors down to the ones
 * whose location names the touched file — `cue vet`'s locations are
 * `.\<file>:line:col` relative to the vet cwd, so the match is a plain
 * basename compare, no path resolution needed.
 *
 * This is now an honest MISSED-finding tradeoff, not an invented-finding
 * bug: an error whose ONLY location is a sibling file is filtered out here
 * (it will surface when that sibling is itself touched), rather than a
 * clean file being wrongly flagged. An error that names the touched file
 * ANYWHERE in its location list — including as a secondary location on a
 * conflict whose primary site is a sibling — is kept, using that location's
 * line/col, because the touched file is a genuine contributor to it.
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

interface CueVetLocation {
	/** Raw path text as `cue vet` printed it, e.g. `.\bad.cue` or `./bad.cue`. */
	file: string;
	line: number;
	column: number;
}

interface CueVetError {
	message: string;
	locations: CueVetLocation[];
}

/**
 * `cue vet` reports each error as a header line (a field path or a bare
 * message, ending in `:`) followed by zero or more indented location lines
 * (`    .\path:line:col`). A syntax error has no field-path prefix; a
 * conflicting-value error carries one location per conflicting side, which
 * can span DIFFERENT files in a multi-file package.
 *
 * Verified against cue v0.17.1:
 *   a: conflicting values int and "hello" (mismatched types int and string):
 *       .\bad.cue:3:4
 *       .\bad.cue:3:10
 *   expected '}', found 'EOF':
 *       .\syntax.cue:2:6
 *   badField.name: conflicting values 5 and string (mismatched types int and string):
 *       .\bad-values.cue:3:11
 *       .\bad-values.cue:4:8
 *       .\schema.cue:4:8
 *
 * A summary-only failure (no location lines at all — e.g. the "some
 * instances are incomplete" message `-c=false` is meant to prevent, or an
 * unrecognized shape from a future cue version) is intentionally NOT
 * silently dropped: the caller falls back to one whole-output diagnostic so
 * a real vet failure can never present as zero findings (recurring defect
 * shape 10) when nothing in the output could be file-attributed at all.
 */
export function parseCueVetOutput(raw: string): CueVetError[] {
	const errors: CueVetError[] = [];
	let current: CueVetError | null = null;
	for (const rawLine of raw.split(/\r?\n/)) {
		if (!rawLine.trim()) continue;
		if (/^\s/.test(rawLine)) {
			if (current) {
				const loc = rawLine.trim().match(/^(.+):(\d+):(\d+)$/);
				if (loc) {
					current.locations.push({
						file: loc[1],
						line: Number.parseInt(loc[2], 10),
						column: Number.parseInt(loc[3], 10),
					});
				}
			}
			continue;
		}
		if (current) errors.push(current);
		current = { message: rawLine.replace(/:\s*$/, "").trim(), locations: [] };
	}
	if (current) errors.push(current);
	return errors;
}

/** `.\bad.cue`, `./bad.cue`, and `bad.cue` all name the same file. */
function locationMatchesFile(location: CueVetLocation, fileName: string): boolean {
	const normalized = location.file.replace(/\\/g, "/").replace(/^\.\//, "");
	return path.posix.basename(normalized) === fileName;
}

/**
 * Filter package-wide vet errors down to the ones that implicate the touched
 * file, and resolve each to that file's own location (the first location
 * line naming it — the field path can carry more than one, see the
 * `badField.name` example above).
 *
 * Returns `undefined` (distinct from an empty array) when NOTHING in the
 * output could be file-attributed at all — every error was either
 * unrecognized (no location lines) or the whole vet failed before producing
 * any structured error — so the caller can fall back to a whole-output
 * diagnostic instead of reporting a false-clean result (shape 10).
 */
export function filterToTouchedFile(
	errors: CueVetError[],
	fileName: string,
): Diagnostic[] | undefined {
	const recognized = errors.filter((error) => error.locations.length > 0);
	if (recognized.length === 0) return undefined;

	const diagnostics: Diagnostic[] = [];
	for (const error of recognized) {
		const match = error.locations.find((location) =>
			locationMatchesFile(location, fileName),
		);
		if (!match) continue; // sibling-only finding — surfaces when that file is touched
		diagnostics.push({
			id: `cue-vet-${diagnostics.length + 1}-${match.line}`,
			message: error.message || "cue vet reported an error",
			filePath: fileName,
			line: match.line,
			column: match.column,
			severity: "error",
			semantic: "blocking",
			tool: "cue-vet",
			rule: "vet",
			fixable: false,
		});
	}
	return diagnostics;
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

		// Package-scoped (F1): vet the whole directory the touched file lives
		// in, not the file alone — CUE packages unify every file that shares a
		// package clause, so a single-file invocation cannot see a definition
		// or value declared in a sibling.
		const result = await safeSpawnAsync(cmd, ["vet", "-c=false", "."], {
			cwd: fileDir,
			timeout: 30_000,
		});

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
		const filtered = filterToTouchedFile(errors, fileName);

		if (filtered === undefined) {
			// Nonzero exit, some output, but nothing in it could be attributed to
			// ANY file — a real failure must not present as zero findings.
			return {
				status: "failed",
				diagnostics: [
					{
						id: "cue-vet-unparsed",
						message: raw.slice(0, 300) || "cue vet exited non-zero",
						filePath: ctx.filePath,
						line: 1,
						column: 1,
						severity: "error",
						semantic: "blocking",
						tool: "cue-vet",
						rule: "vet",
						fixable: false,
					},
				],
				semantic: "blocking",
			};
		}

		if (filtered.length === 0) {
			// The package has real errors, but none of them implicate the touched
			// file — a sibling's problem, not this file's (the F1 tradeoff).
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return { status: "failed", diagnostics: filtered, semantic: "blocking" };
	},
};

export default cueVetRunner;
