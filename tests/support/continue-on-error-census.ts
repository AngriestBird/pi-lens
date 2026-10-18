/**
 * The population reader behind `tests/config/nightly-evaluated-floors.test.ts`
 * (#4518 r2). A `continue-on-error` step or job never reds its own row, so the
 * repository registers every such site in
 * `tests/fixtures/nightly-floors/continue-on-error-sites.json` and the census
 * derives the population from the parsed files.
 *
 * Two review findings shaped this module (#4609 r1):
 *
 * - F1: the population stopped at `.github/workflows/*.yml`. A `.yaml`
 *   workflow or a composite action's step was outside it and outside the
 *   raw-key guard, so a whole advisory producer could be added green. The file
 *   surface is now CLASSIFIED, not globbed: every file under
 *   `.github/workflows/` and `.github/actions/` is either a producer file the
 *   reader parses or a problem that reds the census.
 * - F2: the floor check matched text anywhere in a step's `run:`, so a
 *   commented-out command and an `if: false` step both satisfied it. A floor
 *   now counts only on a line the shell executes, of a step whose `if:` names
 *   a condition the runner evaluates.
 *
 * Review round 2 added three fail-closed rules (#4609 r2):
 *
 * - F-B: the `if:` check enumerated spellings of a constant false, so
 *   `${{ 1 > 2 }}` credited a step the runner skips (shape 69). Every `if:`
 *   that names no context or status function is unproven now; the spelling
 *   list is gone.
 * - F-2: the evidence matched inside a heredoc body, a quoted argument, or
 *   after an unconditional `exit`. Those regions are data the shell never
 *   executes (`evidenceIsExecutable`).
 * - The producer walk reports a non-regular entry (a symlink, a directory
 *   named `*.yml`) as unclassified instead of skipping it.
 *
 * The site enumeration is the parsed document itself (a deep walk), not a
 * regex: a `continue-on-error` key inside a `run:` heredoc or a comment is
 * text, not a key, and a key in a location the reader does not classify reds
 * with its path instead of vanishing (shape 69: derive the rule from the seam).
 */

import { type Dirent as DirEnt, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "../../clients/deps/js-yaml.js";
import { toPosix } from "../../clients/path-utils.js";

/** The two repository roots that can carry a `continue-on-error` producer. */
export const PRODUCER_ROOTS = [".github/workflows", ".github/actions"] as const;

/** The two file suffixes YAML producers are written under. */
const YAML_SUFFIXES = [".yml", ".yaml"] as const;

export type ProducerKind = "workflow" | "composite";

export interface ProducerFile {
	/** Repo-relative POSIX path, the registry key's prefix. */
	path: string;
	kind: ProducerKind;
}

export interface CoeStep {
	name?: string;
	id?: string;
	uses?: string;
	if?: unknown;
	run?: string;
	shell?: string;
	"continue-on-error"?: unknown;
}

export interface CoeJob {
	steps?: CoeStep[];
	"continue-on-error"?: unknown;
}

export interface ProducerDocument {
	jobs?: Record<string, CoeJob>;
	runs?: { using?: unknown; steps?: CoeStep[] };
}

export type CoEStatus = "floored" | "no-floor" | "governed-by";

/** One row of `tests/fixtures/nightly-floors/continue-on-error-sites.json`. */
export interface CoERow {
	status: CoEStatus;
	/** The step in the site's own scope that carries the floor. */
	floorStep?: string;
	/** The exact text in that step's live `run:` proving the floor. */
	evidence?: string;
	/** The issue whose tests own the site (`governed-by` rows). */
	governedBy?: string;
	/** The tests that pin a `governed-by` site. */
	tests?: string[];
	/** The job carries a human-facing `# No floor` header above it. */
	header?: boolean;
	reason: string;
}

/** One `continue-on-error` site: a job, a workflow step, or a composite step. */
export interface CoESite {
	/** Registry key: `<repo path>#<job>[#<step>]`, or `<repo path>#<step>`. */
	key: string;
	file: string;
	kind: ProducerKind;
	/** The job id, or `"composite"` for a composite action's `runs.steps`. */
	scope: string;
	/** The step the key names; absent for a job-level site. */
	step?: CoeStep;
	/** Every step of the site's scope, where a floor step can live. */
	steps: CoeStep[];
	/** The site's index inside `steps`, or -1 when the site is the whole job. */
	index: number;
}

export interface ProducerCensus {
	/** Every classified producer file, sorted by path. */
	files: ProducerFile[];
	/** Files under a producer root that the reader does not classify. */
	unclassified: string[];
	sites: CoESite[];
	/** Every fail-closed shape, ready to print. Empty means clean. */
	problems: string[];
}

/** `A` for an explicit value, never a silent default (GitHub's own rule). */
export const isCoe = (value: unknown): boolean =>
	value !== undefined && value !== false;

/** The step's display identity, the same one the registry key uses. */
export const stepIdentity = (step: CoeStep): string =>
	step.name ?? step.uses?.split("@")[0] ?? "(unnamed step)";

/**
 * Strip shell comments from a `run:` body, quote-aware: a `#` starts a comment
 * only at the start of a word and outside quotes (`"$#"` and `${v#p}` stay
 * code). A floor whose only occurrence sits in a comment is not a gate.
 */
export function stripShellComments(text: string): string {
	const { commentCut } = scanShell(text);
	return text
		.split("\n")
		.map((line, index) => line.slice(0, commentCut[index]))
		.join("\n");
}

/** A step's `run:` with comments removed: the text the runner will execute. */
export const liveRunText = (step: CoeStep): string =>
	stripShellComments(typeof step.run === "string" ? step.run : "");

/** The context roots a workflow expression reads. */
const CONDITION_SOURCE =
	/\b(?:github|matrix|env|steps|needs|inputs|runner|job|vars|secrets)\s*[.[]/;

/** The status functions that decide whether a step runs at all. */
const STATUS_FUNCTION = /\b(?:always|success|failure|cancelled)\s*\(/;

/** Split on `&&` outside quoted strings: each conjunct has to stand alone. */
function conjuncts(expression: string): string[] {
	const parts: string[] = [];
	let quote: '"' | "'" | null = null;
	let start = 0;
	for (let i = 0; i < expression.length; i++) {
		const ch = expression[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"') i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "&" && expression[i + 1] === "&") {
			parts.push(expression.slice(start, i));
			i++;
			start = i + 1;
		}
	}
	parts.push(expression.slice(start));
	return parts;
}

/**
 * Why a floor step's `if:` may never run, or `undefined` when the step has no
 * condition or names a context or status function the runner evaluates
 * (#4609 r2 F-B, Greptile r4306472964). Fail-closed on purpose: the older check
 * enumerated a few spellings of a constant false and treated everything else as
 * live, so `${{ 1 > 2 }}` credited a step the runner skips (shape 69). A value
 * the runner fills in from a context cannot be proven false at rest, so it stays
 * live; every conjunct of an `&&` chain has to be such a value, because
 * `always() && 1 > 2` still never runs.
 */
export function unprovenCondition(condition: unknown): string | undefined {
	const unproven = (value: unknown) =>
		`if: ${String(value)} is not a condition known to run`;
	if (condition === undefined || condition === null || condition === "")
		return undefined;
	// YAML `if: true` parses as a boolean; `if: false` is a constant false.
	if (condition === true) return undefined;
	if (typeof condition !== "string") return unproven(condition);
	const expression = condition
		.trim()
		.replace(/^\$\{\{/, "")
		.replace(/\}\}$/, "")
		.trim();
	if (!expression) return unproven(condition);
	for (const conjunct of conjuncts(expression))
		if (!CONDITION_SOURCE.test(conjunct) && !STATUS_FUNCTION.test(conjunct))
			return unproven(condition);
	return undefined;
}

interface ShellScan {
	/** 1 at every offset the shell never reaches as a command. */
	unreachable: Uint8Array;
	/** 1 at every offset inside a quoted string, delimiters excluded. */
	quoted: Uint8Array;
	/** Per line, the offset of its trailing comment, or the line's length. */
	commentCut: number[];
}

const HEREDOC = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([^\s;|&<>()]+))/;

/**
 * The one quote/comment/heredoc scanner for a `run:` body: which offsets the
 * shell reads as inside a quoted string, and which it never executes (a
 * comment, a heredoc body, or a line after an unconditional `exit`).
 */
function scanShell(text: string): ShellScan {
	const unreachable = new Uint8Array(text.length);
	const quoted = new Uint8Array(text.length);
	const commentCut: number[] = [];
	const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
	let quote: '"' | "'" | null = null;
	let terminated = false;
	let offset = 0;
	for (const line of text.split("\n")) {
		const start = offset;
		const end = offset + line.length;
		offset = end + 1;
		if (terminated) {
			unreachable.fill(1, start, end + 1);
			commentCut.push(line.length);
			continue;
		}
		if (heredocs.length > 0) {
			const top = heredocs[0];
			const body = top.stripTabs ? line.replace(/^\t+/, "") : line;
			unreachable.fill(1, start, end + 1);
			commentCut.push(line.length);
			if (body.trimEnd() === top.delimiter) heredocs.shift();
			continue;
		}
		const openQuote = quote;
		let cut = line.length;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i] ?? "";
			if (quote) {
				quoted[start + i] = 1;
				if (ch === quote) quote = null;
				else if (ch === "\\" && quote === '"' && i + 1 < line.length) {
					i++;
					quoted[start + i] = 1;
				}
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (ch === "\\" && i + 1 < line.length) {
				i++;
				continue;
			}
			if (ch === "#" && (i === 0 || /[\s;]/.test(line[i - 1] ?? ""))) {
				cut = i;
				unreachable.fill(1, start + i, end + 1);
				break;
			}
			if (ch === "<" && line.startsWith("<<", i) && line[i + 2] !== "<") {
				const here = HEREDOC.exec(line.slice(i));
				const delimiter = here?.[2] ?? here?.[3] ?? here?.[4];
				if (delimiter)
					heredocs.push({ delimiter, stripTabs: here?.[1] === "-" });
			}
		}
		commentCut.push(cut);
		const code = line.slice(0, cut);
		// Only an exit at the start of a top-level line ends the script: one
		// inside an `if` body or a function is indented and stays live here.
		if (
			openQuote === null &&
			code === code.trimStart() &&
			/^exit(?:\s+\d+)?\s*$/.test(code.trim())
		)
			terminated = true;
	}
	return { unreachable, quoted, commentCut };
}

/**
 * Whether `evidence` appears on text the shell executes: the match cannot start
 * inside a quoted string, a comment, a heredoc body, or after an unconditional
 * `exit`. `--count "probe=` is live in `node x --count "probe=$n"` because the
 * match starts before the quote; the same text inside `echo '…'` or a heredoc
 * body is data the runner never executes (#4609 r2 F-2, shape 43).
 */
export function evidenceIsExecutable(run: string, evidence: string): boolean {
	if (!evidence) return false;
	const scan = scanShell(run);
	for (
		let at = run.indexOf(evidence);
		at >= 0;
		at = run.indexOf(evidence, at + 1)
	)
		if (!scan.unreachable[at] && !scan.quoted[at]) return true;
	return false;
}

/**
 * Which producer kind a repo-relative path is, or `null` when unclassified.
 * Derived from the path's structure, not from a list of spellings: a workflow
 * is one YAML file directly under `.github/workflows/`, and a composite action
 * is a YAML file named `action.<ext>` at least one directory below
 * `.github/actions/`.
 */
export function classifyProducerFile(path: string): ProducerKind | null {
	const segments = toPosix(path).split("/");
	const file = segments.at(-1) ?? "";
	if (!YAML_SUFFIXES.some((suffix) => file.endsWith(suffix))) return null;
	const [, area, ...rest] = segments;
	if (area === "workflows" && rest.length === 1) return "workflow";
	if (area === "actions" && rest.length >= 2 && file.startsWith("action."))
		return "composite";
	return null;
}

/** One entry the walk found: a path, and whether it is a regular file. */
interface WalkEntry {
	path: string;
	regularFile: boolean;
}

const walkEntries = (root: string, rel: string): WalkEntry[] => {
	let entries: DirEnt[];
	try {
		entries = readdirSync(join(root, rel), { withFileTypes: true });
	} catch {
		// A root that is absent has no producer files; the caller's floors report
		// that, so a silent empty walk cannot read as a clean tree.
		return [];
	}
	return entries.flatMap((entry) => {
		const next = `${rel}/${entry.name}`;
		if (entry.isDirectory())
			return YAML_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
				? [{ path: next, regularFile: false }]
				: walkEntries(root, next);
		// A symlink or any other non-file entry is reported, never parsed: a
		// symlinked `*.yml` is not a workflow GitHub runs, and following it could
		// read a file outside the producer roots (#4609 r2 nitpick).
		return [{ path: next, regularFile: entry.isFile() }];
	});
};

/**
 * Every entry under the producer roots, split into the ones the reader parses
 * and the ones it does not. The second list is the fail-closed surface: a
 * reader that silently ignores a file form is a guard with a hole in it.
 */
export function listProducerFiles(root: string): {
	files: ProducerFile[];
	unclassified: string[];
} {
	const files: ProducerFile[] = [];
	const unclassified: string[] = [];
	for (const dir of PRODUCER_ROOTS)
		for (const entry of walkEntries(root, dir).sort((a, b) =>
			a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
		)) {
			const kind = entry.regularFile ? classifyProducerFile(entry.path) : null;
			if (kind) files.push({ path: entry.path, kind });
			else unclassified.push(entry.path);
		}
	return { files, unclassified };
}

/** Read a producer file. Exported so a fixture tree can drive the same seam. */
export function parseProducerFile(root: string, file: string): unknown {
	return yaml.load(readFileSync(join(root, file), "utf8"));
}

/**
 * Every `continue-on-error` key in the parsed document, with its path. Derived
 * from the document, so a key inside a `run:` heredoc or a comment is not one
 * (r1 LOW-1: the raw-text guard redded a legitimate workflow).
 */
export function coeLocations(
	document: unknown,
): Array<{ path: string[]; value: unknown }> {
	const found: Array<{ path: string[]; value: unknown }> = [];
	const walk = (node: unknown, path: string[]): void => {
		if (Array.isArray(node)) {
			node.forEach((value, index) => walk(value, [...path, String(index)]));
			return;
		}
		if (!node || typeof node !== "object") return;
		for (const [key, value] of Object.entries(node)) {
			const next = [...path, key];
			if (key === "continue-on-error" && isCoe(value))
				found.push({ path: next, value });
			walk(value, next);
		}
	};
	walk(document, []);
	return found;
}

/** The site a key path describes, or `null` when the location is not one. */
function siteForLocation(
	file: string,
	kind: ProducerKind,
	document: ProducerDocument,
	path: readonly string[],
): Omit<CoESite, "key"> | null {
	if (kind === "workflow") {
		if (path[0] !== "jobs" || !path[1]) return null;
		const job = document.jobs?.[path[1]];
		if (!job) return null;
		const steps = job.steps ?? [];
		if (path.length === 2)
			return {
				file,
				kind,
				scope: path[1],
				steps,
				index: -1,
			};
		if (path.length === 4 && path[2] === "steps") {
			const index = Number(path[3]);
			const step = steps[index];
			return step ? { file, kind, scope: path[1], step, steps, index } : null;
		}
		return null;
	}
	const steps = document.runs?.steps ?? [];
	if (path.length === 3 && path[0] === "runs" && path[1] === "steps") {
		const index = Number(path[2]);
		const step = steps[index];
		return step ? { file, kind, scope: "composite", step, steps, index } : null;
	}
	return null;
}

const siteKey = (site: Omit<CoESite, "key">): string =>
	site.step
		? site.kind === "composite"
			? `${site.file}#${stepIdentity(site.step)}`
			: `${site.file}#${site.scope}#${stepIdentity(site.step)}`
		: `${site.file}#${site.scope}`;

/**
 * The sites one parsed producer document declares, plus every location the
 * reader could not classify (a `continue-on-error` key somewhere else in the
 * document is not a producer this census governs).
 */
export function sitesInDocument(
	file: string,
	kind: ProducerKind,
	document: ProducerDocument,
): { sites: CoESite[]; problems: string[] } {
	const sites: CoESite[] = [];
	const problems: string[] = [];
	for (const { path } of coeLocations(document)) {
		// The walk names the key itself; the site is where its parent lives.
		const owner = path.slice(0, -1);
		const site = siteForLocation(file, kind, document, owner);
		if (!site) {
			problems.push(
				`${file}: continue-on-error at an unclassified location: ${path.join(".")}`,
			);
			continue;
		}
		sites.push({ key: siteKey(site), ...site });
	}
	return { sites, problems };
}

/** Read every producer file under `root` into one census. */
export function readProducerCensus(root: string): ProducerCensus {
	const { files, unclassified } = listProducerFiles(root);
	const sites: CoESite[] = [];
	const problems: string[] = unclassified.map(
		(file) =>
			`${file}: an entry under a producer root this reader does not classify: it is not a regular file, or not a file form it parses (workflows are *.yml/*.yaml, actions are <dir>/action.yml|yaml)`,
	);
	for (const file of files) {
		let document: ProducerDocument;
		try {
			document = (parseProducerFile(root, file.path) ?? {}) as ProducerDocument;
		} catch (error) {
			problems.push(
				`${file.path}: unparseable producer file: ${(error as Error).message}`,
			);
			continue;
		}
		const read = sitesInDocument(file.path, file.kind, document);
		sites.push(...read.sites);
		problems.push(...read.problems);
	}
	return { files, unclassified, sites, problems };
}

const isGatingStep = (step: CoeStep): boolean =>
	!isCoe(step["continue-on-error"]);

/**
 * Why a `floored` row is not a gate, or `[]` when it is. The floor step must
 * exist in the site's own scope, cannot itself be `continue-on-error`, must have
 * an `if:` the runner can reach, must come after the site, and must carry the
 * evidence on text the shell executes rather than on data.
 */
export function floorProblems(site: CoESite, row: CoERow): string[] {
	if (row.status !== "floored") return [];
	const problems: string[] = [];
	if (!row.floorStep) problems.push(`${site.key}: no floorStep`);
	if (!row.evidence) problems.push(`${site.key}: no evidence`);
	if (problems.length > 0) return problems;
	const index = site.steps.findIndex((step) =>
		stepIdentity(step).includes(row.floorStep ?? "\u0000"),
	);
	if (index < 0) return [`${site.key}: no step named like "${row.floorStep}"`];
	const floor = site.steps[index];
	if (!isGatingStep(floor))
		problems.push(
			`${site.key}: its floor step is continue-on-error, so the floor gates nothing`,
		);
	const unproven = unprovenCondition(floor.if);
	if (unproven)
		problems.push(
			`${site.key}: its floor step may never run (${unproven}), so the floor is unproven`,
		);
	if (!site.step && site.index < 0 && index >= 0) {
		// A job-level site is gated by a step inside it; nothing to order.
	} else if (index <= site.index)
		problems.push(
			`${site.key}: its floor step runs before the site it is meant to gate`,
		);
	if (
		!evidenceIsExecutable(
			typeof floor.run === "string" ? floor.run : "",
			row.evidence ?? "",
		)
	)
		problems.push(
			`${site.key}: "${row.evidence}" is not on an executable line of that step's run text`,
		);
	return problems;
}

/** The fields each status must carry, and the fields it must not. */
const ROW_FIELDS: Record<CoEStatus, { needs: string[]; forbids: string[] }> = {
	floored: { needs: ["floorStep", "evidence"], forbids: ["governedBy"] },
	"no-floor": { needs: [], forbids: ["floorStep", "evidence"] },
	"governed-by": {
		needs: ["governedBy", "tests"],
		forbids: ["floorStep", "evidence"],
	},
};

/** Why a row itself is not a usable record, or `[]` when it is. */
export function rowProblems(key: string, row: CoERow): string[] {
	const problems: string[] = [];
	if (!Object.hasOwn(ROW_FIELDS, row.status)) {
		problems.push(`${key}: unknown status "${String(row.status)}"`);
		return problems;
	}
	if ((row.reason ?? "").trim().length < 40)
		problems.push(`${key}: reason is missing or under 40 characters`);
	const fields = row as unknown as Record<string, unknown>;
	// An empty list is as empty as a missing one: `tests: []` names nothing.
	const present = (value: unknown) =>
		Array.isArray(value) ? value.length > 0 : Boolean(value);
	const { needs, forbids } = ROW_FIELDS[row.status];
	for (const field of needs)
		if (!present(fields[field]))
			problems.push(`${key}: a ${row.status} row needs ${field}`);
	for (const field of forbids)
		if (fields[field])
			problems.push(`${key}: a ${row.status} row does not carry ${field}`);
	if (
		row.status === "governed-by" &&
		row.governedBy !== undefined &&
		!/^#\d+$/.test(row.governedBy)
	)
		problems.push(`${key}: governed-by rows name an issue as "#<n>"`);
	return problems;
}
