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
 *
 * ## Directory scope can itself be unavailable (review round 2, F5/F6)
 *
 * `cue vet .` is not always a valid unit. Two real, LEGAL directory shapes
 * make it fail before it evaluates anything, with no per-file location at
 * all:
 *
 *   - a package-less standalone file (no `package` clause — the common
 *     single-file config style): `build constraints exclude all CUE files
 *     in .:\n    .\standalone.cue: no package name`;
 *   - two or more DIFFERENT package names sharing one directory (legal CUE —
 *     each is its own independent unit): `found packages "alpha"
 *     (alpha.cue) and "beta" (beta.cue) in "."`.
 *
 * Both verified against cue v0.17.1 (exit 1, no `:line:col` anywhere in the
 * output). Before F5/F6, this read as an unattributable whole-vet failure
 * and blocked every edit to an otherwise-clean file of either shape — a
 * regression the F1 fix introduced. The fix: on either signature, fall back
 * to vetting the touched file ALONE (`cue vet -c=false <file>`), which is
 * the CORRECT scope for a file that cannot be unified with anything in its
 * directory — a package-less file is its own unit by definition, and a
 * differently-packaged sibling is never part of the same value regardless of
 * scope. The single-file result needs no further filtering: every location
 * it reports already belongs to that one file.
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
 * instances are incomplete" message `-c=false` is meant to prevent, a
 * directory-scope failure like `build constraints exclude all CUE files`
 * (handled upstream of this parser — see `directoryScopeUnavailable`), or an
 * unrecognized shape from a future cue version) is intentionally NOT
 * silently dropped: `filterToTouchedFile` and the caller make sure a real
 * vet failure can never present as zero findings (recurring defect shape
 * 10) when nothing in the output could be file-attributed at all.
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

/**
 * True when `cue vet .`'s failure means the DIRECTORY is not a valid vet
 * unit at all — not a finding about any file's content (review round 2,
 * F5/F6). Both signatures are verified against cue v0.17.1 and carry no
 * `:line:col` anywhere in their output, which is exactly why they used to
 * read as an unattributable whole-vet failure and block every edit.
 */
export function directoryScopeUnavailable(raw: string): boolean {
	return (
		/build constraints exclude all CUE files/.test(raw) ||
		// The trailing location cue reports (`in "."` vs `in "two-packages"`)
		// depends on how it resolves the vet cwd, not on the shape of the
		// failure — verified both forms against the real binary — so only the
		// structural "found packages X and Y" part is matched.
		/found packages ".+"\s*\(.+\)\s+and\s+".+"\s*\(.+\)\s+in\s+".*"/.test(raw)
	);
}

/** `.\bad.cue`, `./bad.cue`, and `bad.cue` all name the same file. */
function locationMatchesFile(location: CueVetLocation, fileName: string): boolean {
	const normalized = location.file.replace(/\\/g, "/").replace(/^\.\//, "");
	return path.posix.basename(normalized) === fileName;
}

function toDiagnostic(
	id: string,
	message: string,
	fileName: string,
	line: number,
	column: number,
): Diagnostic {
	return {
		id,
		message: message || "cue vet reported an error",
		filePath: fileName,
		line,
		column,
		severity: "error",
		semantic: "blocking",
		tool: "cue-vet",
		rule: "vet",
		fixable: false,
	};
}

/**
 * Filter package-wide vet errors down to the ones that implicate the touched
 * file, and resolve each to that file's own location (the first location
 * line naming it — the field path can carry more than one, see the
 * `badField.name` example above).
 *
 * Returns `undefined` (distinct from an empty array) only when NOTHING in
 * the output could be file-attributed at all — every error lacked location
 * lines entirely — so the caller can fall back to a whole-output diagnostic
 * instead of reporting a false-clean result (shape 10).
 *
 * ## The mixed case (review round 2, F7)
 *
 * A package-wide vet run can return SEVERAL errors, some with locations and
 * some without. The original rule only fell back to `undefined` when EVERY
 * error lacked a location — so one sibling-located error alongside one
 * genuinely unattributable error made `recognized.length` nonzero, and the
 * unattributable error's diagnostic silently vanished (shape 10, from the
 * filter side this time). There is no file this parser can safely charge an
 * unattributable error to, and no file it can safely clear it from either
 * — so the honest rule is: an unattributable error ALWAYS surfaces on the
 * touched file's result, distinct from (never merged with) a real
 * touched-file location match, and independent of whatever sibling-only
 * errors get filtered out alongside it. Only the fully-uniform case (every
 * error unattributable) still returns `undefined`, so the caller's richer
 * whole-output fallback message is used instead of one row per parsed
 * header.
 */
export function filterToTouchedFile(
	errors: CueVetError[],
	fileName: string,
): Diagnostic[] | undefined {
	if (errors.length === 0) return undefined;
	const withLocation = errors.filter((error) => error.locations.length > 0);
	const unattributable = errors.filter((error) => error.locations.length === 0);
	if (withLocation.length === 0) return undefined;

	const diagnostics: Diagnostic[] = [];
	for (const error of withLocation) {
		const match = error.locations.find((location) =>
			locationMatchesFile(location, fileName),
		);
		if (!match) continue; // sibling-only finding — surfaces when that file is touched
		diagnostics.push(
			toDiagnostic(
				`cue-vet-${diagnostics.length + 1}-${match.line}`,
				error.message,
				fileName,
				match.line,
				match.column,
			),
		);
	}
	// F7: an error this parser could not pin to any file must never be
	// silently dropped just because a SIBLING error happened to carry a
	// location — surface it too, at line 1 since there is nowhere else to
	// point.
	for (const error of unattributable) {
		diagnostics.push(
			toDiagnostic(
				`cue-vet-unattributed-${diagnostics.length + 1}`,
				error.message,
				fileName,
				1,
				1,
			),
		);
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
		let result = await safeSpawnAsync(cmd, ["vet", "-c=false", "."], {
			cwd: fileDir,
			timeout: 30_000,
		});

		if (
			!spawnFailedWithNoOutput(result, `${result.stdout}${result.stderr}`) &&
			result.status !== 0 &&
			directoryScopeUnavailable(`${result.stdout || ""}${result.stderr || ""}`)
		) {
			// F5/F6: the directory itself is not a valid vet unit (package-less
			// file, or two+ differently-packaged files sharing it) — fall back to
			// the touched file alone, which IS a valid unit either way.
			result = await safeSpawnAsync(cmd, ["vet", "-c=false", `./${fileName}`], {
				cwd: fileDir,
				timeout: 30_000,
			});
		}

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
		// The single-file fallback needs no special-casing: every location it
		// reports already belongs to the one file it vetted, so it trivially
		// matches `fileName` and flows through the same filter as the
		// directory-scoped path — one code path, and a single-file run that
		// somehow fails with no location at all still gets the same
		// never-silently-clean `undefined` fallback as the directory path.
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
