// The save-triggered verdict seam (#3405 acceptance 4): the pure classifier and
// table writer behind `scripts/probe-save-verdict.mjs`.
//
// The question the table answers is narrow and must not drift: does a language
// server publish its findings WITHOUT a `textDocument/didSave`, or does only a
// save make it answer? Before this module the column in
// `docs/lsp-capability-matrix.md` was prose moved from a PR body, half of it read
// from each server's source, and no command regenerated it — so a nightly could
// not re-measure it and a reader could not reproduce a cell.
//
// Two properties make the answer trustworthy, and both live here rather than in
// the driver:
//
// - ATTRIBUTION. A row's verdict is decided by which of the measurement ARMS saw
//   the answer, never by what the driver happened to be doing: `noSave` (the
//   seeded error reaches the server as didOpen/didChange only), `silence` (an
//   untriggered window of the same length — a late answer from the first arm
//   lands here and belongs to NO arm, so the row is `inconclusive` rather than
//   credited to the save), `saveAlone` (identical bytes plus a save, so a
//   publish carries the save as its only new input) and `savedWrite` (a
//   diagnostic-neutral byte edit plus a save, the production shape).
// - MERGE. A run that could not reach a server keeps that row verbatim (#390):
//   an unreachable toolchain must never blank a measured cell, so `refresh`
//   rewrites only the rows this run measured.
//
// Dependency-free on purpose (only `md-matrix.mjs`, itself dependency-free, for
// the markdown table primitives): the nightly writes this doc on a checkout where
// `dist/` may not exist yet, and the tests drive every rule without a language
// server.

import { parseTable, replaceTable } from "./md-matrix.mjs";

/** The table this module owns, located by its header prefix. */
export const SAVE_VERDICT_MARKER = "| server | save as declared |";

/** The column whose value states whether only a save produces an answer. */
export const SAVE_VERDICT_COLUMN = "publishes after save only";

/**
 * Every value `publishes after save only` may hold. `unknown` is the only
 * pre-measurement value (a row no run has reached); a MEASURED row must not
 * carry it, and a census in `tests/config/lsp-save-verdict-census.test.ts`
 * pins both directions so a hand edit cannot dress a guess as a measurement.
 */
export const SAVE_VERDICT_VALUES = new Set([
	"unknown",
	"no",
	"no (pull)",
	"yes",
	"yes (saved write)",
	"inconclusive",
	"cannot measure",
]);

/** The `src` token the nightly writes; a developer probe writes `dev`. */
export const SAVE_VERDICT_COMMAND = "node scripts/probe-save-verdict.mjs";

/** An arm with no observation at all (the driver ran it and saw nothing). */
export const SILENT_ARM = Object.freeze({ nonEmpty: 0, ms: null });

function countOf(arm) {
	const n = Number(arm?.nonEmpty ?? 0);
	return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function msOf(arm) {
	const ms = Number(arm?.ms);
	return arm?.nonEmpty > 0 && Number.isFinite(ms) && ms >= 0
		? Math.round(ms)
		: null;
}

/**
 * Classify one server's save verdict from its measurement arms.
 *
 * `mode` is the server's diagnostic mode (`pull` for a server that answers
 * `textDocument/diagnostic`, otherwise a push mode). A pull server never
 * publishes, so its no-save arm is the request's own answer; the verdict is
 * still `no`-family, marked `(pull)` so a reader does not go looking for a
 * publish that never existed.
 *
 * An arm missing from the input (the driver skipped it) is silent: every rule
 * below is positive-evidence-only, so an absent arm can never turn into a `yes`.
 *
 * @param {{
 *   mode?: string,
 *   noSave?: { nonEmpty?: number, ms?: number | null },
 *   silence?: { nonEmpty?: number, ms?: number | null },
 *   saveAlone?: { nonEmpty?: number, ms?: number | null },
 *   savedWrite?: { nonEmpty?: number, ms?: number | null },
 * }} input
 * @returns {{ verdict: string, reason: string }}
 */
export function classifySaveVerdict(input) {
	const mode = input?.mode === "pull" ? "pull" : "push";
	const noSave = countOf(input?.noSave);
	const silence = countOf(input?.silence);
	const saveAlone = countOf(input?.saveAlone);
	const savedWrite = countOf(input?.savedWrite);

	if (noSave > 0) {
		return {
			verdict: mode === "pull" ? "no (pull)" : "no",
			reason:
				mode === "pull"
					? "the diagnostics request answered the seeded finding with no save, so the save is not the trigger"
					: "the seeded finding published without a save, so the save is not the trigger",
		};
	}
	// A publish in the untriggered window is a late answer from an earlier arm.
	// Crediting it to the arm that followed would turn a slow server into a
	// save-triggered one, which is the one wrong direction that matters here.
	if (silence > 0) {
		return {
			verdict: "inconclusive",
			reason: `${silence} finding(s) arrived in the untriggered window after the no-save arm, so no arm owns the answer`,
		};
	}
	if (saveAlone > 0) {
		return {
			verdict: "yes",
			reason:
				"the same bytes produced nothing without a save and findings after the save alone",
		};
	}
	if (savedWrite > 0) {
		return {
			verdict: "yes (saved write)",
			reason:
				"neither the unsaved seed nor the save alone published, and a diagnostic-neutral edit plus a save did",
		};
	}
	return {
		verdict: "inconclusive",
		reason:
			"no arm published, so this fixture does not distinguish a save-triggered server from one that never diagnoses it",
	};
}

/** `3 findings at 97 ms`, or `silent`. */
export function describeArm(arm, waitMs) {
	const n = countOf(arm);
	if (n === 0) return `silent (${waitMs} ms)`;
	const ms = msOf(arm);
	return `${n} finding${n === 1 ? "" : "s"} at ${ms ?? "?"} ms`;
}

/**
 * The clean-gate policy a fixture already declares, so a regenerated row keeps
 * saying whether the server gates the nightly. Derived from the fixture, never
 * restated by hand: the table cannot then claim a policy the harness no longer
 * applies.
 *
 * @param {{ auxiliaryServerIds?: string[], lspGate?: boolean, lspGateExempt?: string }} fixture
 */
export function fixturePolicy(fixture) {
	if (fixture?.auxiliaryServerIds?.length) return "Auxiliary, not gated.";
	if (fixture?.lspGate === true) return "Gated.";
	if (typeof fixture?.lspGateExempt === "string")
		return "Exempt from the clean gate.";
	return "";
}

/**
 * Render the three owned cells of one measured row.
 *
 * @param {{
 *   server: string,
 *   save: string,
 *   mode: string,
 *   fixture: { lang: string, auxiliaryServerIds?: string[], lspGate?: boolean, lspGateExempt?: string },
 *   arms: Parameters<typeof classifySaveVerdict>[0],
 *   waitMs: number,
 *   src: string,
 * }} row
 * @returns {Record<string, string>} cell values keyed by column name
 */
export function saveVerdictCells(row) {
	const { verdict, reason } = classifySaveVerdict({
		mode: row.mode,
		...row.arms,
	});
	const noSave = describeArm(row.arms?.noSave, row.waitMs);
	const saveAlone = describeArm(row.arms?.saveAlone, row.waitMs);
	const savedWrite = describeArm(row.arms?.savedWrite, row.waitMs);
	const observation = {
		no: `Measured: ${verdict === "no (pull)" ? "pull mode — the diagnostics request answered the seeded finding with no save" : `answers without a save (${noSave} on didOpen); a later save alone: ${saveAlone}`}.`,
		"no (pull)": `Measured: pull mode — no save needed; a later save alone: ${saveAlone}.`,
		yes: `Measured: only the save published — silent on didOpen (${row.waitMs} ms), then ${saveAlone} after the save alone.`,
		"yes (saved write)": `Measured: only a saved write published — silent on didOpen and on the save alone, then ${savedWrite} on a diagnostic-neutral edit plus a save.`,
	}[verdict];
	const policy = fixturePolicy(row.fixture);
	const verdictCell =
		observation ??
		`Measured: inconclusive — ${reason} (arms: no-save ${noSave}, save alone ${saveAlone}, saved write ${savedWrite}).`;
	return {
		server: row.server,
		// Backticked like every other declaration cell in the doc, so a reader sees
		// a protocol token rather than prose.
		"save as declared": `\`${row.save}\``,
		[SAVE_VERDICT_COLUMN]: verdict,
		verdict: policy ? `${verdictCell} ${policy}` : verdictCell,
		evidence: `\`${SAVE_VERDICT_COMMAND}\` (src=${row.src}, fixture ${row.fixture?.lang ?? row.server})`,
	};
}

/**
 * Merge this run's measured rows into the doc's save-verdict table.
 *
 * Rows this run did not measure are copied verbatim — the merge guard that keeps
 * an unreachable toolchain from blanking a measured cell (#390).
 *
 * A measured server with no row is NOT appended: the table's population is the
 * capability inventory's save-declaring servers (one row per registry SERVER id),
 * and a fixture whose launch VARIANT declares `save` under an id the inventory
 * records as declaring none (`typescript`'s TS7 variants, #3405) would otherwise
 * add a row contradicting the inventory. Those servers are reported as
 * `notInTable` so the run's log names them, and the census in
 * `tests/config/lsp-save-verdict-census.test.ts` keeps the table's population
 * equal to the inventory's.
 *
 * @param {string} text
 * @param {Array<Record<string, string>>} measured  rows keyed by column name
 * @param {{ marker?: string }} [opts]
 * @returns {{
 *   text: string,
 *   changed: boolean,
 *   measured: string[],
 *   kept: string[],
 *   notInTable: string[],
 *   reason?: string,
 * }}
 */
export function refreshSaveVerdictTable(text, measured, opts = {}) {
	const marker = opts.marker ?? SAVE_VERDICT_MARKER;
	const table = parseTable(text, marker);
	const rows = measured ?? [];
	if (!table) {
		return {
			text,
			changed: false,
			measured: [],
			kept: [],
			notInTable: [],
			reason: "save-verdict table not found in doc",
		};
	}
	const keyIdx = table.header.indexOf("server");
	const byKey = new Map(rows.map((row) => [row.server, row]));
	const merged = [];
	const measuredServers = [];
	const kept = [];
	for (const cells of table.rows) {
		const row = byKey.get(cells[keyIdx]);
		if (!row) {
			merged.push(cells);
			kept.push(cells[keyIdx]);
			continue;
		}
		merged.push(
			cells.map((cell, i) => {
				const column = table.header[i];
				return row[column] !== undefined ? row[column] : cell;
			}),
		);
		measuredServers.push(cells[keyIdx]);
	}
	const tableKeys = new Set(table.rows.map((cells) => cells[keyIdx]));
	const out = replaceTable(text, marker, table.header, table.sep, merged);
	return {
		text: out,
		changed: out !== text,
		measured: measuredServers,
		kept,
		notInTable: rows
			.map((row) => row.server)
			.filter((server) => !tableKeys.has(server)),
	};
}

/**
 * The rows the doc currently holds, as `{ server, save, verdict }`. The driver
 * reads the verdict back to probe the rows nobody has measured FIRST, so a
 * bounded nightly converges on the unmeasured population instead of re-spending
 * its budget on rows that already have a measured verdict.
 *
 * @param {string} text
 * @param {{ marker?: string }} [opts]
 * @returns {Array<{ server: string, save: string, verdict: string }>}
 */
export function parseSaveVerdictRows(text, opts = {}) {
	const table = parseTable(text, opts.marker ?? SAVE_VERDICT_MARKER);
	if (!table) return [];
	const idx = (name) => table.header.indexOf(name);
	const server = idx("server");
	const save = idx("save as declared");
	const verdict = idx(SAVE_VERDICT_COLUMN);
	return table.rows.map((cells) => ({
		server: cells[server],
		save: cells[save],
		verdict: cells[verdict],
	}));
}

/**
 * Order the probe's fixtures: rows the doc has NOT measured first, then the rest.
 *
 * Without this a bounded run spends its budget in fixture order and can starve
 * exactly the rows the table needs (#3405: nine unverified servers sat behind
 * twelve source-read ones). Ties keep fixture order, so a run over already
 * measured rows is still deterministic.
 *
 * @template {{ lang: string }} F
 * @param {F[]} fixtures
 * @param {Array<{ server: string, verdict: string }>} rows
 * @param {(fixture: F) => string} serverOf
 * @param {Iterable<string>} [alreadyMeasured] values that count as measured
 * @returns {F[]}
 */
export function orderByNeed(
	fixtures,
	rows,
	serverOf,
	alreadyMeasured = [
		"no",
		"no (pull)",
		"yes",
		"yes (saved write)",
		"cannot measure",
	],
) {
	const measuredVerdicts = new Set(alreadyMeasured);
	const measuredServers = new Set(
		(rows ?? [])
			.filter((row) => measuredVerdicts.has(row.verdict))
			.map((row) => row.server),
	);
	const unmeasured = [];
	const measured = [];
	for (const fixture of fixtures ?? []) {
		(measuredServers.has(serverOf(fixture)) ? measured : unmeasured).push(
			fixture,
		);
	}
	return [...unmeasured, ...measured];
}
