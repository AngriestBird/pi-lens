/**
 * #4532: honest rendering for TypeScript diagnostics produced by a root whose
 * dependency install does not resolve.
 *
 * A pi session edited a file in a linked worktree that had no `node_modules`.
 * The `typescript` server rooted there published seven severity-1 rows: TS2307
 * on `node:crypto`, TS2503 on `NodeJS`, and TS2304 for the four `node` timer
 * globals. Every one of them is an AMBIENT-DECLARATION gap — `@types/node` is
 * not installed, so the server has no `NodeJS` namespace, no `node:` module
 * types and no timer globals — and none is a defect in the edited file. pi-lens
 * rendered them as `🔴 STOP — 7 issue(s) must be fixed`, four times over ten
 * minutes; the agent cannot fix a missing install by editing code, and the
 * blockers starved the cascade (`cascade_skip reason=primary_has_blockers`).
 *
 * DEMOTE-WITH-LABEL, never suppress, exactly as #1640's inferred-project rule
 * does for its own config gap: the finding keeps its line, its code and its
 * evidence, and its text names the environment it needs. The difference is what
 * proves the demotion. #1640 asks the server which project a file belongs to;
 * this asks the filesystem whether any dependency install could be resolved for
 * it, which costs a bounded walk-up of `stat` calls and no server request.
 *
 * FAIL CLOSED (AGENTS shape 69). The gate admits a closed list of (code,
 * operand) pairs from the TypeScript server and refuses every other form:
 * another code (a real type error), another server (an auxiliary sharing the
 * same result), a specifier that resolves from the project itself (relative,
 * absolute, or a `#` subpath import), a missing name that is not one of `node`'s
 * globals, and any root that resolves a `node_modules` at all. A demotion this
 * gate should not have made hides a real blocker, so the refusal direction is
 * the one the tests spend the most cells on.
 *
 * The one "we do not know" path changes nothing: an unreadable directory in the
 * walk-up, a message the admitted parse cannot read, or a diagnostic whose
 * producer cannot be named leaves the finding at its published severity. An
 * unanswered question is not a verdict (AGENTS shape 10).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LSPDiagnostic } from "./client.js";
import { isTypeScriptSourcedDiagnostic } from "./inferred-project.js";
import { incrementDegradationCount } from "../degradation-ledger.js";
import { logLatency } from "../latency-logger.js";

/**
 * The stable, greppable half of the label. A finding that survives at reduced
 * authority says so in its own text, so no downstream renderer has to be taught
 * about the demotion separately (the same contract `INFERRED_PROJECT_MARKER`
 * carries).
 */
export const ENVIRONMENT_GAP_MARKER =
	"no dependency install resolved for this workspace";

/** The full label appended to a demoted diagnostic's message. */
export const ENVIRONMENT_GAP_NOTICE = `[${ENVIRONMENT_GAP_MARKER}; install the project's dependencies (npm ci, pnpm install, …) and the server picks them up on its next restart]`;

/** The registered id of the server whose ambient declarations are at stake. */
const TYPESCRIPT_SERVER_ID = "typescript";

/** Walk-up levels one environment question may stat (fail closed past it). */
export const ENV_NODE_MODULES_WALK_MAX_LEVELS = 32;

/**
 * `node`'s own global declarations, all of which live in `@types/node`. A
 * missing name is only an environment gap when it is one of these; every other
 * name is a real reference error. Kept as one closed list rather than a regex
 * so an unlisted spelling stays blocking.
 */
export const NODE_GLOBALS: ReadonlySet<string> = new Set([
	"process",
	"Buffer",
	"require",
	"module",
	"exports",
	"__dirname",
	"__filename",
	"global",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"setImmediate",
	"clearImmediate",
	"queueMicrotask",
	"structuredClone",
	"URL",
	"URLSearchParams",
	"TextEncoder",
	"TextDecoder",
	"AbortController",
	"AbortSignal",
	"fetch",
	"performance",
]);

/** `Cannot find module '<specifier>' or its corresponding type declarations.` */
const MISSING_MODULE = /^Cannot find module '([^']+)'/;
/** `Cannot find namespace '<name>'.` */
const MISSING_NAMESPACE = /^Cannot find namespace '([^']+)'/;
/** `Cannot find name '<name>'.` */
const MISSING_NAME = /^Cannot find name '([^']+)'/;

/** The namespace `@types/node` declares and nothing else in a TS project does. */
const NODE_NAMESPACE = "NodeJS";

/** Codes this gate can demote at all; every other code stays blocking. */
const ENVIRONMENT_GAP_CODES = new Set([2307, 2503, 2304]);

/**
 * A bare specifier is resolved from `node_modules`; a relative, absolute or
 * drive-absolute one is resolved from the project, and a `#`-prefixed one from
 * the project's own `package.json` `imports` map. Only the first form can be
 * missing BECAUSE no install exists.
 */
function isBareSpecifier(specifier: string): boolean {
	if (specifier.startsWith("node:")) return true;
	if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
	if (specifier.startsWith("#")) return false;
	if (/^[A-Za-z]:[\\/]/.test(specifier)) return false;
	// A URL or a bare path-like token with a separator at the front is not a
	// package name either; `@scope/name` and `name/sub` are.
	return !specifier.includes("\\") || specifier.startsWith("@");
}

/**
 * Whether this diagnostic is an environment gap for a root with no resolvable
 * `node_modules`. Returns the admitted code when it is, `undefined` otherwise,
 * so the caller records what fired rather than re-deriving it.
 */
export function environmentGapKind(
	diagnostic: LSPDiagnostic,
): 2307 | 2503 | 2304 | undefined {
	if (diagnostic.severity !== 1) return undefined;
	if (!isTypeScriptSourcedDiagnostic(diagnostic)) return undefined;
	if (
		diagnostic.serverId !== undefined &&
		diagnostic.serverId !== TYPESCRIPT_SERVER_ID
	)
		return undefined;
	const code = Number(diagnostic.code);
	if (!ENVIRONMENT_GAP_CODES.has(code)) return undefined;
	const message = diagnostic.message.trim();
	if (code === 2307) {
		const specifier = MISSING_MODULE.exec(message)?.[1];
		return specifier !== undefined && isBareSpecifier(specifier)
			? 2307
			: undefined;
	}
	if (code === 2503) {
		return MISSING_NAMESPACE.exec(message)?.[1] === NODE_NAMESPACE
			? 2503
			: undefined;
	}
	const name = MISSING_NAME.exec(message)?.[1];
	return name !== undefined && NODE_GLOBALS.has(name) ? 2304 : undefined;
}

/**
 * Whether some directory at or above `startDir` holds a `node_modules` entry.
 *
 * The walk starts at the file's own directory and continues ABOVE the client
 * root, because `node` and tsserver both resolve upward past it: an install one
 * level above the server's root still resolves the file's imports, so demoting
 * there would hide a real blocker. A symlink that does not resolve stats as
 * absent, which is the reported case — the worktree's `node_modules` was
 * dangling or missing, and a dangling link is no install.
 *
 * Fail-closed direction: a directory that cannot be statted for a reason other
 * than absence (permissions, I/O) answers "resolvable", so the finding keeps its
 * published severity.
 */
export function hasResolvableNodeModules(
	startDir: string,
	stat: (candidate: string) => fs.Stats = (candidate) => fs.statSync(candidate),
): boolean {
	let dir = path.resolve(startDir);
	for (let level = 0; level < ENV_NODE_MODULES_WALK_MAX_LEVELS; level++) {
		try {
			stat(path.join(dir, "node_modules"));
			return true;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				// Unreadable is not absent: keep the finding blocking.
				return true;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	// The cap is a depth bound, not a verdict: an unbounded ancestry could still
	// hold an install, so past it the question is unanswered and the finding
	// stays blocking.
	return true;
}

export interface EnvironmentGapOptions {
	filePath: string;
	/**
	 * Test seam: the directory the walk-up starts from. Defaults to the file's
	 * own directory, which is where `node`'s own resolution starts.
	 */
	startDir?: string;
	/** Test seam: the `stat` the walk-up uses. */
	stat?: (candidate: string) => fs.Stats;
}

/**
 * Pure transform: demote every admitted environment gap to a warning and append
 * the label. Warnings, hints, auxiliary-sourced findings and every refused form
 * are returned untouched.
 *
 * Returns the SAME array reference when nothing changed, so callers can cheaply
 * skip rebuilding their result objects (the contract
 * `demoteInferredProjectDiagnostics` already follows).
 */
export function demoteEnvironmentGapDiagnostics(
	diagnostics: LSPDiagnostic[],
	options: EnvironmentGapOptions,
): LSPDiagnostic[] {
	const admitted = new Map<LSPDiagnostic, 2307 | 2503 | 2304>();
	for (const diagnostic of diagnostics) {
		const kind = environmentGapKind(diagnostic);
		if (kind !== undefined) admitted.set(diagnostic, kind);
	}
	if (admitted.size === 0) return diagnostics;
	// One filesystem question per file, asked only when a demotion could act.
	if (
		hasResolvableNodeModules(
			options.startDir ?? path.dirname(options.filePath),
			options.stat,
		)
	)
		return diagnostics;
	const startedAt = Date.now();
	const counts = new Map<number, number>();
	const demoted = diagnostics.map((diagnostic) => {
		const kind = admitted.get(diagnostic);
		if (kind === undefined) return diagnostic;
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
		return {
			...diagnostic,
			severity: 2 as const,
			message: `${diagnostic.message} ${ENVIRONMENT_GAP_NOTICE}`,
		};
	});
	for (const [code, count] of counts) {
		// One record per admitted code per session: the count carries the repeat,
		// as every bounded degradation does.
		incrementDegradationCount({
			kind: "lsp-environment-gap-demoted",
			subject: String(code),
			reason: `TS${code} from a root with no resolvable node_modules: the finding keeps its line and loses blocking authority while the dependencies are absent`,
			metadata: { code, count, filePath: options.filePath },
		});
	}
	logLatency({
		type: "phase",
		phase: "lsp_environment_gap_demote",
		filePath: options.filePath,
		durationMs: Date.now() - startedAt,
		metadata: {
			demoted: demoted.length - (diagnostics.length - admitted.size),
			considered: diagnostics.length,
			codes: [...counts.keys()].sort().join(","),
		},
	});
	return demoted;
}

/**
 * Whether this run should record that a root's install is missing for a
 * finding it demoted. The ledger's own once/count pair already bounds the
 * record, so this only names the seam's answer for a caller that wants to know.
 */
export function environmentGapAdmitted(diagnostic: LSPDiagnostic): boolean {
	return environmentGapKind(diagnostic) !== undefined;
}
