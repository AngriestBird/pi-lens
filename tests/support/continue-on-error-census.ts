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
 *   now counts only on a live line of a step the runner does not disable.
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
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		let quote: '"' | "'" | null = null;
		let cut = line.length;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (quote) {
				if (ch === quote) quote = null;
				else if (ch === "\\" && quote === '"') i++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (ch === "#" && (i === 0 || /[\s;]/.test(line[i - 1]))) {
				cut = i;
				break;
			}
		}
		lines.push(line.slice(0, cut));
	}
	return lines.join("\n");
}

/** A step's `run:` with comments removed: the text the runner will execute. */
export const liveRunText = (step: CoeStep): string =>
	stripShellComments(typeof step.run === "string" ? step.run : "");

/**
 * A condition the runner evaluates as a constant false. Bounded on purpose: an
 * expression this does not resolve is treated as live, because guessing
 * "disabled" would excuse a step that does run.
 */
export function constantFalse(condition: unknown): boolean {
	if (condition === false) return true;
	if (typeof condition !== "string") return false;
	const expression = condition
		.trim()
		.replace(/^\$\{\{/, "")
		.replace(/\}\}$/, "")
		.trim()
		.toLowerCase();
	return (
		expression === "false" ||
		expression === "!true" ||
		expression === "0" ||
		expression === "null" ||
		expression === "''" ||
		expression === '""'
	);
}

/** Why the runner cannot execute this step, or `undefined` when it can. */
export function disabledReason(step: CoeStep): string | undefined {
	return constantFalse(step.if) ? `if: ${String(step.if)}` : undefined;
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

const walkFiles = (root: string, rel: string): string[] => {
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
		if (entry.isDirectory()) return walkFiles(root, next);
		return entry.isFile() ? [next] : [];
	});
};

/**
 * Every file under the producer roots, split into the ones the reader parses
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
		for (const rel of walkFiles(root, dir).sort()) {
			const kind = classifyProducerFile(rel);
			if (kind) files.push({ path: rel, kind });
			else unclassified.push(rel);
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
			`${file}: a file under a producer root this reader does not classify (workflows are *.yml/*.yaml, actions are <dir>/action.yml|yaml)`,
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
 * exist in the site's own scope, cannot itself be `continue-on-error`, must be
 * one the runner executes, must come after the site, and must carry the
 * evidence on a live (uncommented) line of its `run:`.
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
	const disabled = disabledReason(floor);
	if (disabled)
		problems.push(
			`${site.key}: its floor step never runs (${disabled}), so the floor gates nothing`,
		);
	if (!site.step && site.index < 0 && index >= 0) {
		// A job-level site is gated by a step inside it; nothing to order.
	} else if (index <= site.index)
		problems.push(
			`${site.key}: its floor step runs before the site it is meant to gate`,
		);
	if (!liveRunText(floor).includes(row.evidence ?? "\u0000"))
		problems.push(
			`${site.key}: "${row.evidence}" is not on a live line of that step's run text`,
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
