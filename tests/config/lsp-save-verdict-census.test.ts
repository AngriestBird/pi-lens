import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type ParsedTable, parseTable } from "../../scripts/lib/md-matrix.mjs";
import {
	parseSaveVerdictRows,
	SAVE_VERDICT_COLUMN,
	SAVE_VERDICT_COMMAND,
	SAVE_VERDICT_MARKER,
	SAVE_VERDICT_VALUES,
} from "../../scripts/lib/save-verdict.mjs";

/**
 * The census for `docs/lsp-capability-matrix.md`'s per-server save verdicts
 * (#3405 acceptance 4).
 *
 * ## What this file is for
 *
 * The table sat in a PR body for a year and then landed as prose: five measured
 * rows, seven read from each server's source, nine `unknown`. Nothing tied a
 * cell to a command, so nothing could re-measure it and no reader could
 * reproduce one. The issue's done-when is "every server has a measured verdict in
 * a tree file, with the probe that produced it".
 *
 * Completeness cannot be a gate — a runner that cannot install a toolchain keeps
 * a row at its last measured value (the merge guard in
 * `scripts/lib/save-verdict.mjs`), and gating on "no `unknown` rows" would make
 * every such night red. What CAN be a gate, and is, is that the table stays
 * honest and reproducible:
 *
 * - every server the capability inventory says declares `textDocumentSync.save`
 *   has a row here, so a newly registered save-declaring server cannot go
 *   missing;
 * - `publishes after save only` holds only a value the classifier can produce — a
 *   new spelling reds instead of entering the vocabulary by hand;
 * - an unmeasured row says it is unverified, and a row with a verdict names where
 *   that verdict came from, so a hand edit cannot dress a guess as a measurement;
 * - the probe's own evidence and a `Measured:` row are paired in both directions;
 * - the section names the command that produced the table, which is the issue's
 *   "reproducible" requirement;
 * - `cannot measure` cannot stand without its reason.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const MATRIX = resolve(ROOT, "docs/lsp-capability-matrix.md");
const INVENTORY = resolve(ROOT, "docs/servercapabilities.md");

const matrixText = readFileSync(MATRIX, "utf8");
const rows = parseSaveVerdictRows(matrixText);
const byServer = new Map(rows.map((row) => [row.server, row]));

/** The save-verdict table, or a failure — a missing table is not a clean census. */
function saveTable(): ParsedTable {
	const table = parseTable(matrixText, SAVE_VERDICT_MARKER);
	if (!table) throw new Error(`no save-verdict table in ${MATRIX}`);
	return table;
}

/** The save declarations the capability inventory (the population's source) records. */
function inventorySaveDeclarations(): Map<string, string> {
	const table = parseTable(
		readFileSync(INVENTORY, "utf8"),
		"| server | mode | ws-pull | save |",
	);
	if (!table) throw new Error(`no capability inventory table in ${INVENTORY}`);
	const saveIdx = table.header.indexOf("save");
	const serverIdx = table.header.indexOf("server");
	const declarations = new Map<string, string>();
	for (const cells of table.rows) {
		const declared = cells[saveIdx];
		if (declared === "save" || declared === "save+text")
			declarations.set(cells[serverIdx], declared);
	}
	return declarations;
}

describe("save verdict census (#3405)", () => {
	it("finds the save-verdict table and a non-empty population", () => {
		// A floor of one keeps the census from passing on an empty parse — the
		// #3310 shape, where a dead instrument and a healthy one look identical.
		expect(rows.length).toBeGreaterThan(15);
		expect(inventorySaveDeclarations().size).toBeGreaterThan(15);
	});

	it("gives every save-declaring server its own row", () => {
		const missing = [...inventorySaveDeclarations().keys()].filter(
			(server) => !byServer.has(server),
		);
		expect(missing).toEqual([]);
	});

	it("keeps every verdict inside the classifier's vocabulary", () => {
		const strays = rows
			.filter((row) => !SAVE_VERDICT_VALUES.has(row.verdict))
			.map((row) => `${row.server}: ${row.verdict}`);
		expect(strays).toEqual([]);
	});

	it("never dresses a guess as a measurement", () => {
		const table = saveTable();
		const verdictIdx = table.header.indexOf("verdict");
		const evidenceIdx = table.header.indexOf("evidence");
		const saveIdx = table.header.indexOf(SAVE_VERDICT_COLUMN);
		const offenders = table.rows
			.filter((cells) => {
				const value = cells[saveIdx];
				const prose = cells[verdictIdx] ?? "";
				const evidence = cells[evidenceIdx] ?? "";
				// An unmeasured row says so, and a row with a verdict says where the
				// verdict came from (a failed prior probe is provenance too).
				if (value === "unknown") return !/unverified/i.test(prose);
				return /^none$/i.test(evidence) || evidence === "";
			})
			.map((cells) => cells[0]);
		expect(offenders).toEqual([]);
	});

	it("pairs the probe's own evidence with a measured row", () => {
		const table = saveTable();
		const verdictIdx = table.header.indexOf("verdict");
		const evidenceIdx = table.header.indexOf("evidence");
		const saveIdx = table.header.indexOf(SAVE_VERDICT_COLUMN);
		const mismatched = table.rows
			.filter((cells) => {
				const fromProbe = (cells[evidenceIdx] ?? "").includes(
					SAVE_VERDICT_COMMAND,
				);
				const readsMeasured = (cells[verdictIdx] ?? "").startsWith("Measured:");
				const hasVerdict = cells[saveIdx] !== "unknown";
				return fromProbe !== (readsMeasured && hasVerdict);
			})
			.map((cells) => cells[0]);
		expect(mismatched).toEqual([]);
	});

	it("names the regeneration command in the section, so the table is reproducible", () => {
		// The issue's done-when: a tree file with the probe that produced it. A
		// reader must be able to regenerate a cell, not only trust it.
		expect(matrixText).toContain(SAVE_VERDICT_COMMAND);
	});

	it("keeps a reason on a `cannot measure` row", () => {
		const table = saveTable();
		const verdictIdx = table.header.indexOf("verdict");
		const saveIdx = table.header.indexOf(SAVE_VERDICT_COLUMN);
		const bare = table.rows
			.filter(
				(cells) =>
					cells[saveIdx] === "cannot measure" &&
					!/cannot measure: \S/i.test(cells[verdictIdx] ?? ""),
			)
			.map((cells) => cells[0]);
		expect(bare).toEqual([]);
	});
});
